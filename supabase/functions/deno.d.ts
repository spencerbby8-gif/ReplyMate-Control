/**
 * Minimal ambient declarations so the Edge Function can be type-checked with the
 * repository's TypeScript, without installing the Deno toolchain or a network
 * dependency for a file that is not part of the Next.js build.
 *
 * This is deliberately NOT a substitute for real Deno type-checking. Before
 * deploying, run `deno check supabase/functions/replymate-ai/index.ts` in an
 * environment with the Deno CLI and the real `@supabase/supabase-js` types; that
 * is the authoritative check. These stubs exist so `tsc -p supabase/functions`
 * catches genuine logic errors (wrong argument types, unknown properties,
 * unhandled unions) in CI today rather than only at deploy time.
 */

declare namespace Deno {
  const env: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
  };
  function serve(handler: (request: Request) => Response | Promise<Response>): void;
}

/** Remote ESM imports cannot be resolved offline; the real types come from Deno. */
declare module "https://esm.sh/@supabase/supabase-js@2" {
  export function createClient(
    url: string,
    key: string,
    options?: Record<string, unknown>,
  ): {
    auth: {
      getUser(): Promise<{
        data: { user: { id: string; email?: string | null; is_anonymous?: boolean } | null } | null;
        error: { message: string } | null;
      }>;
    };
    from(table: string): {
      select(columns: string, options?: Record<string, unknown>): QueryBuilder;
      update(values: Record<string, unknown>): QueryBuilder;
      insert(values: Record<string, unknown> | Array<Record<string, unknown>>): PromiseLike<{
        error: { code?: string; message: string } | null;
      }>;
    };
  };

  type QueryBuilder = {
    eq(column: string, value: unknown): QueryBuilder;
    order(column: string, options?: Record<string, unknown>): QueryBuilder;
    limit(count: number): QueryBuilder;
    gte(column: string, value: unknown): QueryBuilder;
    lte(column: string, value: unknown): QueryBuilder;
    then<TResult>(
      onFulfilled: (value: {
        data: Array<Record<string, unknown>> | null;
        error: { code?: string; message: string } | null;
        count: number | null;
      }) => TResult,
    ): Promise<TResult>;
  };
}
