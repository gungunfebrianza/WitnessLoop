// a worker with no behaviour: the test only needs a registration to capture and restore
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
