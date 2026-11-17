export const ENV = {
  // Fallbacks so local username/password login works without Manus env vars
  appId: process.env.VITE_APP_ID?.trim() || "local-app",
  cookieSecret:
    process.env.JWT_SECRET?.trim() ||
    process.env.COOKIE_SECRET?.trim() ||
    "local-dev-jwt-secret-change-me",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  massiveApiKey: process.env.MASSIVE_API_KEY ?? "",
  zerionApiKey: process.env.ZERION_API_KEY ?? "",
};
