import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectionCapability, ConnectionSummary, ConnectionsResponse } from "@shared/connections.js";
import { apiClient } from "@/shared/lib/api-client";

/** The shared connection list: every capability page picks a connection and one of its models from here. */
export function useConnections() {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    apiClient.get<ConnectionsResponse>("/api/connections")
      .then((next) => { if (active) setData(next); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : String(err)); });
    return () => { active = false; };
  }, [generation]);
  const byId = useMemo(() => new Map((data?.connections ?? []).map((item) => [item.id, item])), [data]);
  const forCapability = (capability: ConnectionCapability): ConnectionSummary[] =>
    (data?.connections ?? []).filter((item) => item.capabilities.includes(capability));
  return { connections: data?.connections ?? [], byId, forCapability, loading: !data && !error, error, refresh };
}
