// Inline PostHog loader for static content pages (blog, /vs, guides).
// Mirrors the SPA's init in src/main.ts + super-props in src/analytics.ts so a
// reader who lands on a blog post and later opens the app stays the same
// distinct_id, with the same device/landing context attached. Same-origin —
// midee.app cookies are shared, no cross-domain config needed.
//
// Returns '' when VITE_POSTHOG_KEY is unset (dev / forks) so generated HTML
// stays clean and no script tag fires. Session recording is a project-level
// PostHog setting; enable it in Project Settings → Replay if you want
// blog→app session replays stitched into one timeline.

const KEY = process.env.VITE_POSTHOG_KEY
const HOST = process.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com'

// Official PostHog array-loader. Async, ~1KB inline. Loads /static/array.js
// from the assets host and stubs the API so calls before load are queued.
const LOADER = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init Ee Ss Os capture Re calculateEventProperties Os register register_once register_for_session unregister unregister_for_session js getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey canRenderSurveyAsync identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty Ts $s createPersonProfile Is opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing Ms debug Ls getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`

export function renderPosthogSnippet() {
  if (!KEY) return ''
  // Keep `defaults` and `person_profiles` in sync with src/main.ts so events
  // from blog and app share one canonical configuration. The IIFE registers
  // the same super-props as registerAnalyticsContext() — duplicated here on
  // purpose to avoid pulling a TS module into the static build pipeline.
  return `<script>
${LOADER}
posthog.init(${JSON.stringify(KEY)}, {
  api_host: ${JSON.stringify(HOST)},
  defaults: '2026-01-30',
  person_profiles: 'always',
});
(function () {
  var w = window.innerWidth, h = window.innerHeight;
  posthog.register({
    device_type: w < 640 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop',
    pointer: matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine',
    orientation: matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape',
    is_pwa: matchMedia('(display-mode: standalone)').matches,
    viewport_w: w,
    viewport_h: h,
  });
  var u = new URL(location.href);
  posthog.register_once({
    landing_path: u.pathname,
    landing_referrer: document.referrer || '(direct)',
    landing_utm_source: u.searchParams.get('utm_source'),
    landing_utm_medium: u.searchParams.get('utm_medium'),
    landing_utm_campaign: u.searchParams.get('utm_campaign'),
  });
})();
</script>`
}
