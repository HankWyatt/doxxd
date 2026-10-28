declare namespace Cloudflare {
  interface Env {
    DMND_API_BASE_URL?: string;
    DMND_API_KEY?: string;
    DMND_ENABLED_PROTOCOLS?: string;
    DMND_ALLOWED_WALLETS?: string;
    DMND_REQUEST_BUDGET?: string;
    DMND_ACCEPTANCE_PROXY_TOKEN?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
