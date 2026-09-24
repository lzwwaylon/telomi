"""In-place embedding migration for Hindsight storage.

A replacement vector column fills beside the serving one while the service keeps
running; the cutover swaps the columns and rebuilds the vector indexes while the
service is drained. Memory Units, Mental Models, their ids, links and entities
are never rewritten, so nothing is lost when the model or its dimension changes.
Phases are idempotent: an interrupted prepare resumes where it stopped and abort
returns storage to the pre-migration shape. Storage the service has not created
yet holds nothing to migrate; the service creates it at the selected dimension.
"""
import argparse
import asyncio
import json
import re
import sys
from datetime import datetime

from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

SHADOW = "embedding_next"
BATCH_SIZE = 64
TABLES = ("memory_units", "mental_models")


def _format_readable_date(value: datetime) -> str:
    # Mirrors MemoryEngine._format_readable_date so migrated vectors match freshly retained ones.
    return f"{value.strftime('%B')} {value.strftime('%Y')}"


def memory_unit_text(row, entities: list[str]) -> str:
    from hindsight_api.engine.retain.embedding_processing import augment_texts_with_dates
    from hindsight_api.engine.retain.types import ExtractedFact

    if row.fact_type == "observation":
        return row.text
    fact = ExtractedFact(fact_text=row.text, fact_type=row.fact_type, entities=entities,
                         occurred_start=row.occurred_start, occurred_end=row.occurred_end, mentioned_at=row.mentioned_at)
    return augment_texts_with_dates([fact], _format_readable_date)[0]


def mental_model_text(row) -> str:
    return f"{row.name} {row.content}"


def embed(embeddings, texts: list[str]) -> list[list[float]]:
    from hindsight_api.engine.retain import embedding_utils

    return asyncio.run(embedding_utils.generate_embeddings_batch(embeddings, texts, "document"))


def vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(repr(float(value)) for value in vector) + "]"


class EmbeddingMigration:
    def __init__(self, database_url: str, schema: str = "public", emit=None):
        from hindsight_api.db_url import to_libpq_url

        self.engine = create_engine(to_libpq_url(database_url), poolclass=NullPool)
        self.schema = schema
        self.emit = emit or (lambda event: None)

    def column_dimension(self, conn, table: str, column: str):
        return conn.execute(text("""
            SELECT atttypmod FROM pg_attribute a
            JOIN pg_class c ON a.attrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE n.nspname = :schema AND c.relname = :table AND a.attname = :column AND NOT a.attisdropped
        """), {"schema": self.schema, "table": table, "column": column}).scalar()

    def tables(self, conn) -> list[str]:
        return [table for table in TABLES
                if conn.execute(text("SELECT to_regclass(:name)"), {"name": f"{self.schema}.{table}"}).scalar() is not None]

    def estimate(self) -> dict:
        with self.engine.connect() as conn:
            units = characters = 0
            for table in self.tables(conn):
                row = conn.execute(text(f"SELECT COUNT(*), COALESCE(SUM(LENGTH({'text' if table == 'memory_units' else 'content'})), 0) "
                                        f"FROM {self.schema}.{table} WHERE embedding IS NOT NULL")).one()
                units += int(row[0])
                characters += int(row[1])
            return {"units": units, "characters": characters, "dimension": self.column_dimension(conn, "memory_units", "embedding")}

    def prepare(self, embeddings) -> None:
        dimension = int(embeddings.dimension)
        if dimension > 2000:
            raise RuntimeError(f"Embedding dimension {dimension} exceeds the pgvector HNSW index limit of 2000")
        with self.engine.begin() as conn:
            tables = self.tables(conn)
            for table in tables:
                current = self.column_dimension(conn, table, SHADOW)
                if current is not None and current != dimension:
                    conn.execute(text(f"ALTER TABLE {self.schema}.{table} DROP COLUMN {SHADOW}"))
                    current = None
                if current is None:
                    conn.execute(text(f"ALTER TABLE {self.schema}.{table} ADD COLUMN {SHADOW} vector({dimension})"))
        total = self.estimate()["units"]
        done = 0
        with self.engine.connect() as conn:
            for table in tables:
                done += conn.execute(text(f"SELECT COUNT(*) FROM {self.schema}.{table} WHERE embedding IS NOT NULL AND {SHADOW} IS NOT NULL")).scalar()
        self.emit({"event": "progress", "done": done, "total": total})
        for table in tables:
            while True:
                with self.engine.begin() as conn:
                    if table == "memory_units":
                        rows = conn.execute(text(f"""
                            SELECT id, text, fact_type, occurred_start, occurred_end, mentioned_at FROM {self.schema}.memory_units
                            WHERE embedding IS NOT NULL AND {SHADOW} IS NULL ORDER BY created_at, id LIMIT :limit
                        """), {"limit": BATCH_SIZE}).all()
                        if not rows:
                            break
                        entities: dict = {}
                        for unit_id, name in conn.execute(text(f"""
                            SELECT ue.unit_id, e.canonical_name FROM {self.schema}.unit_entities ue
                            JOIN {self.schema}.entities e ON e.id = ue.entity_id WHERE ue.unit_id = ANY(:ids) ORDER BY e.canonical_name
                        """), {"ids": [row.id for row in rows]}).all():
                            entities.setdefault(unit_id, []).append(name)
                        texts = [memory_unit_text(row, entities.get(row.id, [])) for row in rows]
                    else:
                        rows = conn.execute(text(f"""
                            SELECT id, name, content FROM {self.schema}.mental_models
                            WHERE embedding IS NOT NULL AND {SHADOW} IS NULL ORDER BY created_at, id LIMIT :limit
                        """), {"limit": BATCH_SIZE}).all()
                        if not rows:
                            break
                        texts = [mental_model_text(row) for row in rows]
                    vectors = embed(embeddings, texts)
                    if len(vectors) != len(rows) or any(len(vector) != dimension for vector in vectors):
                        raise RuntimeError("Embedding model returned vectors of an unexpected shape")
                    for row, vector in zip(rows, vectors):
                        conn.execute(text(f"UPDATE {self.schema}.{table} SET {SHADOW} = CAST(:vector AS vector) WHERE id = :id"),
                                     {"vector": vector_literal(vector), "id": row.id})
                    done += len(rows)
                self.emit({"event": "progress", "done": done, "total": total})

    def cutover(self, embeddings) -> None:
        # Writes that landed since the last prepare still need vectors; the service is drained now.
        self.prepare(embeddings)
        with self.engine.begin() as conn:
            for table in self.tables(conn):
                if self.column_dimension(conn, table, SHADOW) is None:
                    raise RuntimeError(f"{table} has no prepared replacement column")
                indexes = conn.execute(text("""
                    SELECT indexname, indexdef FROM pg_indexes
                    WHERE schemaname = :schema AND tablename = :table AND indexdef LIKE '%(embedding %'
                """), {"schema": self.schema, "table": table}).all()
                for name, _definition in indexes:
                    conn.execute(text(f'DROP INDEX IF EXISTS {self.schema}."{name}"'))
                conn.execute(text(f"ALTER TABLE {self.schema}.{table} DROP COLUMN embedding"))
                conn.execute(text(f"ALTER TABLE {self.schema}.{table} RENAME COLUMN {SHADOW} TO embedding"))
                for _name, definition in indexes:
                    conn.execute(text(definition))

    def abort(self) -> None:
        with self.engine.begin() as conn:
            for table in self.tables(conn):
                conn.execute(text(f"ALTER TABLE {self.schema}.{table} DROP COLUMN IF EXISTS {SHADOW}"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--phase", choices=["estimate", "prepare", "cutover", "abort"], required=True)
    args = parser.parse_args()
    from hindsight_api.pg0 import resolve_database_url

    database_url = asyncio.run(resolve_database_url(args.database_url))
    emit = lambda event: print(json.dumps(event), flush=True)  # noqa: E731
    migration = EmbeddingMigration(database_url, emit=emit)
    if args.phase == "estimate":
        emit({"event": "estimate", **migration.estimate()})
    elif args.phase == "abort":
        migration.abort()
    else:
        from hindsight_api.engine.embeddings import create_embeddings_from_env

        embeddings = create_embeddings_from_env()
        asyncio.run(embeddings.initialize())
        getattr(migration, args.phase)(embeddings)
    emit({"event": "done"})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        # Provider errors can quote request bodies and driver errors the connection URL; the page needs neither.
        message = re.sub(r"[a-z0-9+]+://[^\s'\"]*@[^\s'\"]*", "<database>", str(error)[:300])
        print(f"{type(error).__name__}: {message}", file=sys.stderr)
        sys.exit(1)
