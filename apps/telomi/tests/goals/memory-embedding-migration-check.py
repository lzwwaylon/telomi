"""Real Hindsight storage semantics for the embedding migration, with a deterministic embedder in place of a model."""
import asyncio
import hashlib
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "hindsight"))
os.environ.setdefault("HINDSIGHT_API_EMBEDDINGS_MAX_INPUT_TOKENS", "")

from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402
from hindsight_api.db_url import to_libpq_url  # noqa: E402
from hindsight_api.engine.embeddings import Embeddings  # noqa: E402
from hindsight_api.migrations import ensure_embedding_dimension, run_migrations  # noqa: E402
from hindsight_api.pg0 import EmbeddedPostgres  # noqa: E402
import pg0  # noqa: E402

import telomi_embedding_migration as migration  # noqa: E402


class FakeEmbeddings(Embeddings):
    """Vectors derive from the text and a salt, so a same-dimension model change is observable."""

    def __init__(self, dimension: int, salt: str, fail_after: int | None = None):
        self._dimension = dimension
        self.salt = salt
        self.fail_after = fail_after
        self.calls = 0
        self.texts: list[str] = []

    @property
    def provider_name(self):
        return "fake"

    @property
    def dimension(self):
        return self._dimension

    async def initialize(self):
        return None

    def encode(self, texts):
        self.calls += 1
        if self.fail_after is not None and self.calls > self.fail_after:
            raise RuntimeError("embedding service unavailable")
        self.texts.extend(texts)
        return [self.vector(item) for item in texts]

    def vector(self, item: str) -> list[float]:
        digest = hashlib.sha256(f"{self.salt}:{item}".encode()).digest()
        return [digest[index % len(digest)] / 255 for index in range(self._dimension)]


def parse_vector(value) -> list[float]:
    return [float(item) for item in str(value).strip("[]").split(",")]


def main() -> None:
    name = f"telomi-embedding-check-{os.getpid()}"
    server = EmbeddedPostgres(name=name)
    url = asyncio.run(server.start())
    try:
        # Before the service ever started there is no storage: every phase has nothing to do.
        empty = migration.EmbeddingMigration(url)
        assert empty.estimate() == {"units": 0, "characters": 0, "dimension": None}
        unused = FakeEmbeddings(4, "empty")
        empty.prepare(unused)
        empty.cutover(unused)
        empty.abort()
        assert unused.calls == 0
        run_migrations(url)
        ensure_embedding_dimension(url, 4)
        engine = create_engine(to_libpq_url(url), poolclass=NullPool)
        bank = "check-bank"
        ids = [uuid.uuid4() for _ in range(3)]
        old = FakeEmbeddings(4, "old")
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO banks (bank_id) VALUES (:bank)"), {"bank": bank})
            internal_id = conn.execute(text("SELECT internal_id FROM banks WHERE bank_id = :bank"), {"bank": bank}).scalar()
            uid = str(internal_id).replace("-", "")[:16]
            for fact_type, suffix in (("world", "worl"), ("experience", "expr"), ("observation", "obsv")):
                conn.execute(text(f"CREATE INDEX IF NOT EXISTS idx_mu_emb_{suffix}_{uid} ON memory_units USING hnsw (embedding vector_cosine_ops) "
                                  f"WHERE fact_type = '{fact_type}' AND bank_id = '{bank}'"))
            rows = [
                (ids[0], "Ada moved to Lisbon", "world", "2024-06-03T00:00:00+00:00"),
                (ids[1], "Ada prefers tea", "experience", None),
                (ids[2], "Ada tends to relocate in summer", "observation", None),
            ]
            for unit_id, body, fact_type, occurred in rows:
                conn.execute(text("""
                    INSERT INTO memory_units (id, bank_id, text, embedding, event_date, occurred_start, mentioned_at, fact_type)
                    VALUES (:id, :bank, :text, CAST(:embedding AS vector), now(), CAST(:occurred AS timestamptz), now(), :fact_type)
                """), {"id": unit_id, "bank": bank, "text": body, "embedding": migration.vector_literal(old.vector(body)),
                        "occurred": occurred, "fact_type": fact_type})
            entity_id = uuid.uuid4()
            conn.execute(text("INSERT INTO entities (id, canonical_name, bank_id) VALUES (:id, 'Ada', :bank)"), {"id": entity_id, "bank": bank})
            conn.execute(text("INSERT INTO unit_entities (unit_id, entity_id) VALUES (:unit, :entity)"), {"unit": ids[0], "entity": entity_id})
            conn.execute(text("INSERT INTO memory_links (from_unit_id, to_unit_id, link_type, weight, bank_id) VALUES (:a, :b, 'temporal', 0.5, :bank)"), {"a": ids[0], "b": ids[1], "bank": bank})
            conn.execute(text("""
                INSERT INTO mental_models (bank_id, subtype, name, description, source_query, content, embedding, tags)
                VALUES (:bank, 'pinned', 'Ada profile', ' ', 'who is Ada', 'Ada lives in Lisbon and drinks tea', CAST(:embedding AS vector), '{}')
            """), {"bank": bank, "embedding": migration.vector_literal(old.vector("Ada profile Ada lives in Lisbon and drinks tea"))})

        def snapshot(conn):
            return {
                "units": conn.execute(text("SELECT id, text, fact_type FROM memory_units ORDER BY text")).all(),
                "links": conn.execute(text("SELECT from_unit_id, to_unit_id, link_type, weight FROM memory_links")).all(),
                "entities": conn.execute(text("SELECT unit_id, entity_id FROM unit_entities")).all(),
                "models": conn.execute(text("SELECT id, name, content FROM mental_models")).all(),
            }

        def dimension(conn, table="memory_units", column="embedding"):
            return migration.EmbeddingMigration(url).column_dimension(conn, table, column)

        def vector_index_count(conn):
            return conn.execute(text("SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'memory_units' AND indexname LIKE 'idx_mu_emb_%'")).scalar()

        with engine.connect() as conn:
            before = snapshot(conn)
            assert dimension(conn) == 4 and vector_index_count(conn) == 3

        events = []
        runner = migration.EmbeddingMigration(url, emit=events.append)
        assert runner.estimate() == {"units": 4, "characters": sum(len(row[1]) for row in before["units"]) + len("Ada lives in Lisbon and drinks tea"), "dimension": 4}

        # Failure during prepare: the serving column is untouched and abort removes the partial replacement.
        broken = FakeEmbeddings(6, "new", fail_after=0)
        try:
            runner.prepare(broken)
            raise AssertionError("prepare must fail when the model fails")
        except Exception as error:  # noqa: BLE001
            assert "unavailable" in str(error)
        with engine.connect() as conn:
            assert dimension(conn) == 4 and dimension(conn, column=migration.SHADOW) == 6
        runner.abort()
        with engine.connect() as conn:
            assert dimension(conn, column=migration.SHADOW) is None and snapshot(conn) == before

        # Interrupted prepare resumes: rows already filled are not embedded again.
        partial = FakeEmbeddings(6, "new", fail_after=1)
        try:
            runner.prepare(partial)
            raise AssertionError("prepare must stop when the model fails mid-way")
        except Exception:  # noqa: BLE001
            pass
        first_batch = len(partial.texts)
        assert 0 < first_batch < 4
        new = FakeEmbeddings(6, "new")
        runner.prepare(new)
        assert len(new.texts) == 4 - first_batch, "resume embeds only what the interrupted run left"
        with engine.connect() as conn:
            assert dimension(conn) == 4, "the serving column keeps its dimension until cutover"
            assert conn.execute(text(f"SELECT COUNT(*) FROM memory_units WHERE {migration.SHADOW} IS NULL")).scalar() == 0

        # A write that lands after prepare, before the drained cutover, still gets its replacement vector.
        late_id = uuid.uuid4()
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO memory_units (id, bank_id, text, embedding, event_date, fact_type)
                VALUES (:id, :bank, 'Ada adopted a cat', CAST(:embedding AS vector), now(), 'world')
            """), {"id": late_id, "bank": bank, "embedding": migration.vector_literal(old.vector("Ada adopted a cat"))})
        cut = FakeEmbeddings(6, "new")
        runner.cutover(cut)
        assert cut.texts == ["Ada adopted a cat"], cut.texts
        with engine.connect() as conn:
            assert dimension(conn) == 6 and dimension(conn, "mental_models") == 6
            assert dimension(conn, column=migration.SHADOW) is None
            after = snapshot(conn)
            assert after["links"] == before["links"] and after["entities"] == before["entities"] and after["models"] == before["models"]
            assert [row[0] for row in after["units"]] == sorted([*ids, late_id], key=lambda item: {ids[0]: "Ada moved to Lisbon", ids[1]: "Ada prefers tea", ids[2]: "Ada tends to relocate in summer", late_id: "Ada adopted a cat"}[item])
            assert vector_index_count(conn) == 3, "per-bank vector indexes are rebuilt"
            stored = parse_vector(conn.execute(text("SELECT embedding FROM memory_units WHERE id = :id"), {"id": ids[0]}).scalar())
            assert stored == [round(value, 6) for value in new.vector("Ada moved to Lisbon (happened in June 2024) [Ada]")] or \
                [round(value, 6) for value in stored] == [round(value, 6) for value in new.vector("Ada moved to Lisbon (happened in June 2024) [Ada]")], \
                "world facts embed with the same date and entity augmentation retain uses"
            observation = parse_vector(conn.execute(text("SELECT embedding FROM memory_units WHERE id = :id"), {"id": ids[2]}).scalar())
            assert [round(value, 6) for value in observation] == [round(value, 6) for value in new.vector("Ada tends to relocate in summer")]
            model_vector = parse_vector(conn.execute(text("SELECT embedding FROM mental_models")).scalar())
            assert [round(value, 6) for value in model_vector] == [round(value, 6) for value in new.vector("Ada profile Ada lives in Lisbon and drinks tea")]
        # Hindsight's own startup check accepts the migrated dimension on populated tables.
        ensure_embedding_dimension(url, 6)

        # Same dimension, different model: vectors change even though the column does not.
        same = FakeEmbeddings(6, "same-dimension-replacement")
        runner.prepare(same)
        runner.cutover(same)
        with engine.connect() as conn:
            assert dimension(conn) == 6 and snapshot(conn) == after
            replaced = parse_vector(conn.execute(text("SELECT embedding FROM memory_units WHERE id = :id"), {"id": ids[1]}).scalar())
            mentioned = conn.execute(text("SELECT mentioned_at FROM memory_units WHERE id = :id"), {"id": ids[1]}).scalar()
            assert [round(value, 6) for value in replaced] == [round(value, 6) for value in same.vector(f"Ada prefers tea (happened in {mentioned.strftime('%B %Y')})")], \
                "experience facts without an occurrence date embed with their mentioned-at month, as retain does"
        assert events and events[-1]["event"] == "progress" and events[-1]["done"] == events[-1]["total"] == 5, events[-1]
        print("memory embedding migration storage check passed")
    finally:
        asyncio.run(server.stop())
        pg0.drop(name)


if __name__ == "__main__":
    main()
