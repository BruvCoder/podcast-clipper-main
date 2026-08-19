import { ProxyAgent, fetch as undiciFetch } from "undici";
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
  if (!undiciAgent) {
    // undici does not reliably read credentials embedded in the proxy URL —
    // they have to be supplied as an explicit Basic token, with a
    // credential-free uri. Passing the full URL fails with "fetch failed"
    // even when the same proxy works fine via curl.
    const parsed = new URL(PROXY_URL);
    const username = decodeURIComponent(parsed.username || "");
    const password = decodeURIComponent(parsed.password || "");
    parsed.username = "";
    parsed.password = "";
    const uri = parsed.toString().replace(/\/$/, "");

    undiciAgent = new ProxyAgent(
      username || password
        ? { uri, token: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
        : { uri }
    );
  }
  return undiciAgent;
}

/** Agent for node http/https requests that should go through the proxy. */
export function mediaAgent() {
  if (!PROXY_URL) return undefined;
  if (!nodeAgent) nodeAgent = new HttpsProxyAgent(PROXY_URL);
  return nodeAgent;
}

/**
 * fetch() that routes through the media proxy when one is configured.
 *
 * Uses undici's own fetch rather than the global one when proxying: Node
 * bundles its own copy of undici, and handing the global fetch a dispatcher
 * built by the npm-installed undici fails with "invalid onRequestStart
 * method". Pairing undici's fetch with undici's agent keeps both on the
 * same version. Without a proxy, the global fetch is used unchanged.
 */
export function mediaFetch(url, options = {}) {
  const dispatcher = mediaDispatcher();
  if (!dispatcher) return fetch(url, options);
  return undiciFetch(url, { ...options, dispatcher });
}
