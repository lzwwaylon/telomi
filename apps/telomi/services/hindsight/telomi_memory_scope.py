"""Keep live and archived Telomi Episode Facts in their document's scope."""

from hindsight_api.config import get_config
from hindsight_api.engine.db_utils import acquire_with_retry
from hindsight_api.engine.memories import get_memories
from hindsight_api.models import RequestContext


async def install_scope_integrity(memory):
    # ponytail: Hindsight 0.9 omits archived Facts on retag; remove once upstream covers atomic retag/restore.
    config = get_config()
    if config.database_backend != "postgresql" or not get_memories().writes_memory_rows_in_sql:
        return
    schema = '"' + (config.database_schema or "public").replace('"', '""') + '"'
    backend = await memory._get_backend()
    async with acquire_with_retry(backend) as conn:
        async with conn.transaction():
            await conn.execute(f"LOCK TABLE {schema}.documents, {schema}.memory_units, {schema}.invalidated_memory_units IN SHARE ROW EXCLUSIVE MODE")
            await conn.execute(f"""
                CREATE OR REPLACE FUNCTION {schema}.telomi_episode_insert_scope() RETURNS trigger
                LANGUAGE plpgsql AS $telomi$
                BEGIN
                    IF NEW.fact_type IN ('world', 'experience')
                       AND NEW.document_id ~ '^pi-(task|turn|schedule-proposal)-' THEN
                        EXECUTE format('SELECT tags FROM %I.documents WHERE id = $1 AND bank_id = $2 FOR SHARE', TG_TABLE_SCHEMA)
                            INTO NEW.tags USING NEW.document_id, NEW.bank_id;
                    END IF;
                    RETURN NEW;
                END;
                $telomi$;
                CREATE OR REPLACE FUNCTION {schema}.telomi_episode_archive_scope() RETURNS trigger
                LANGUAGE plpgsql AS $telomi$
                BEGIN
                    IF NEW.id ~ '^pi-(task|turn|schedule-proposal)-' THEN
                        EXECUTE format('UPDATE %I.invalidated_memory_units SET tags = $1
                            WHERE document_id = $2 AND bank_id = $3
                              AND fact_type IN (''world'', ''experience'') AND tags IS DISTINCT FROM $1', TG_TABLE_SCHEMA)
                            USING NEW.tags, NEW.id, NEW.bank_id;
                    END IF;
                    RETURN NEW;
                END;
                $telomi$;
                DROP TRIGGER IF EXISTS telomi_episode_archive_scope ON {schema}.documents;
                CREATE TRIGGER telomi_episode_archive_scope AFTER UPDATE OF tags ON {schema}.documents
                    FOR EACH ROW EXECUTE FUNCTION {schema}.telomi_episode_archive_scope();
            """)
            for table in ("memory_units", "invalidated_memory_units"):
                events = "INSERT OR UPDATE OF tags" if table == "memory_units" else "INSERT"
                await conn.execute(f"""
                    DROP TRIGGER IF EXISTS telomi_episode_insert_scope ON {schema}.{table};
                    CREATE TRIGGER telomi_episode_insert_scope BEFORE {events} ON {schema}.{table}
                        FOR EACH ROW EXECUTE FUNCTION {schema}.telomi_episode_insert_scope();
                """)
            await conn.execute(f"""
                UPDATE {schema}.invalidated_memory_units AS unit SET tags = doc.tags
                FROM {schema}.documents AS doc
                WHERE unit.document_id = doc.id AND unit.bank_id = doc.bank_id
                  AND doc.id ~ '^pi-(task|turn|schedule-proposal)-'
                  AND unit.fact_type IN ('world', 'experience') AND unit.tags IS DISTINCT FROM doc.tags
            """)
            repair = await conn.fetch(f"""
                SELECT DISTINCT doc.id, doc.bank_id, doc.tags FROM {schema}.documents AS doc
                JOIN {schema}.memory_units AS unit ON unit.document_id = doc.id AND unit.bank_id = doc.bank_id
                WHERE doc.id ~ '^pi-(task|turn|schedule-proposal)-'
                  AND unit.fact_type IN ('world', 'experience') AND unit.tags IS DISTINCT FROM doc.tags
                ORDER BY doc.bank_id, doc.id
            """)
    # Native retag also removes derived observations carrying the old scope before re-consolidation.
    for document in repair:
        await memory.update_document(document["id"], document["bank_id"], tags=list(document["tags"] or []),
                                     request_context=RequestContext(internal=True))
