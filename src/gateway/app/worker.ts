export const SERVICE_WORKER: string = String.raw`
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("agentsocks", {
      body: "You have new messages",
      tag: "agentsocks",
      renotify: true,
      icon: "/app/icon.png",
    }),
  );
});

const inApp = (url) => {
  const path = new URL(url).pathname;
  return path === "/app" || path.startsWith("/app/");
};

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => inApp(w.url));
      return open ? open.focus() : self.clients.openWindow("/app/");
    }),
  );
});
`;
