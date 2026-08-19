import { ProxyAgent } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";

// Both media CDNs discriminate by requesting IP, verified by running the
// same request from a home connection and from the deployed container:
//
//   audio CDN (123tokyo.xyz)  home: 200/206   datacenter: 404
//   video CDN (googlevideo)   serves ~3MB per signed URL, then 403 forever
//
// Routing only the media fetches through a residential proxy is what makes
// this work from a hosted environment. Everything else (RapidAPI, Groq,
// Firebase) goes direct — those are not IP-restricted, and proxy bandwidth
// is metered, so there is no reason to send them through it.
const PROXY_URL = process.env.MEDIA_PROXY_URL || "";

let undiciAgent = null;
let nodeAgent = null;

export function mediaProxyEnabled() {
  return Boolean(PROXY_URL);
}

/** Dispatcher for global fetch() calls that should go through the proxy. */
export function mediaDispatcher() {
  if (!PROXY_URL) return undefined;
  if (!undiciAgent) undiciAgent = new ProxyAgent(PROXY_URL);
  return undiciAgent;
}

/** Agent for node http/https requests that should go through the proxy. */
export function mediaAgent() {
  if (!PROXY_URL) return undefined;
  if (!nodeAgent) nodeAgent = new HttpsProxyAgent(PROXY_URL);
  return nodeAgent;
}

/** fetch() that routes through the media proxy when one is configured. */
export function mediaFetch(url, options = {}) {
  const dispatcher = mediaDispatcher();
  return fetch(url, dispatcher ? { ...options, dispatcher } : options);
}
