export const firebaseConfig = {
  apiKey: "AIzaSyCIEMgK0tV7rxAiMESlxTDxL6AM8FgQnIk",
  authDomain: "codexproposals.firebaseapp.com",
  projectId: "codexproposals",
  storageBucket: "codexproposals.firebasestorage.app",
  messagingSenderId: "493694529297",
  appId: "1:493694529297:web:7e3c3f461269102b19e6b0"
};

export function isFirebaseConfigured(config = firebaseConfig) {
  return Boolean(
    config.apiKey &&
    config.authDomain &&
    config.projectId &&
    config.appId
  );
}
