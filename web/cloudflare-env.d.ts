declare namespace Cloudflare {
  interface Env {
    DMND_API_BASE_URL?: string;
    DMND_API_KEY?: string;
    DMND_ENABLED_PROTOCOLS?: string;
    DMND_ALLOWED_WALLETS?: string;
    DMND_REQUEST_BUDGET?: string;
    DMND_ACCEPTANCE_PROXY_TOKEN?: string;
    // On-site LP actions: on only when this is "1" and SOLANA_RPC_URL is set.
    DOXXD_ACTIONS_ENABLED?: string;
    // Server-only secret: the RPC provider URL behind /api/rpc (it usually
    // carries a key). Required for actions; no default, because the public
    // api.mainnet-beta.solana.com refuses requests from Workers.
    SOLANA_RPC_URL?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
