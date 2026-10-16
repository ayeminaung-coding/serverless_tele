// Copy to config.js (git-ignored by convention — never commit the real one):
//   cp console/config.example.js console/config.js
// Then set API_BASE to the deployed Worker URL.
window.APP_CONFIG = {
  API_BASE: "https://telegram-serverless.<account>.workers.dev"
};
