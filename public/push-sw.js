/* LiftCircle push handlers, loaded into the generated Workbox service worker via workbox.importScripts
 * (vite.config.ts). Adds no caching or routes: the SW still only precaches the build and serves the navigation
 * fallback, and Supabase paths are never cached.
 *
 * push              → ALWAYS shows a notification (iOS revokes permission for silent pushes). Payload JSON:
 *                     { title, body, url, tag }. Same tag = a newer notification replaces the older one.
 * notificationclick → focuses an open LiftCircle window (navigating it to the url) or opens the url.
 * pushsubscriptionchange → re-subscribes with the same key and tells open windows, which upload the new
 *                     subscription; otherwise the app refreshes it on its next start.
 */
(function (sw) {
  'use strict';

  function parse(event) {
    var data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch (e) {
      try {
        data = { body: event.data ? event.data.text() : '' };
      } catch (e2) {
        data = {};
      }
    }
    var url = typeof data.url === 'string' && data.url.charAt(0) === '/' && data.url.charAt(1) !== '/' ? data.url : '/';
    return {
      title: typeof data.title === 'string' && data.title ? data.title.slice(0, 80) : 'LiftCircle',
      body: typeof data.body === 'string' ? data.body.slice(0, 200) : '',
      url: url,
      tag: typeof data.tag === 'string' && data.tag ? data.tag.slice(0, 40) : 'liftcircle',
    };
  }

  sw.lcShowPush = function (event) {
    var p = parse(event);
    return sw.registration.showNotification(p.title, {
      body: p.body,
      tag: p.tag,
      renotify: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: p.url },
    });
  };

  sw.lcOpenUrl = function (url) {
    var target = new URL(url || '/', sw.location.origin).href;
    return sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (new URL(c.url).origin === sw.location.origin && 'focus' in c) {
          return Promise.resolve(c.navigate && c.url !== target ? c.navigate(target).catch(function () { return c; }) : c).then(function (w) {
            return (w || c).focus();
          });
        }
      }
      return sw.clients.openWindow ? sw.clients.openWindow(target) : undefined;
    });
  };

  sw.addEventListener('push', function (event) {
    event.waitUntil(sw.lcShowPush(event));
  });

  sw.addEventListener('notificationclick', function (event) {
    event.notification.close();
    var url = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(sw.lcOpenUrl(url));
  });

  sw.addEventListener('pushsubscriptionchange', function (event) {
    var old = event.oldSubscription;
    var key = old && old.options ? old.options.applicationServerKey : null;
    if (!key) return;
    event.waitUntil(
      sw.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).then(function (sub) {
        return sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
          list.forEach(function (c) {
            c.postMessage({ type: 'lc-push-subscription-changed', subscription: sub.toJSON() });
          });
        });
      }),
    );
  });
})(self);
