import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { isApiError } from "./errors";
import { authEvents } from "./session";

function onUnauthorized(error: unknown) {
  if (isApiError(error) && error.status === 401) authEvents.emit("expired");
}

export function makeQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: onUnauthorized }),
    mutationCache: new MutationCache({ onError: onUnauthorized }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        // No WebSockets: refetch when the window regains focus (board + inbox also poll every 30s).
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: (count, error) => {
          if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
          return count < 1;
        },
        retryDelay: 600,
      },
      mutations: { retry: false },
    },
  });
}
