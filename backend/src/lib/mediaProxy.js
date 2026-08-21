import {
  ProxyAgent,
  fetch as undiciFetch,
  request as undiciRequest,
} from "undici";
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
const MAX_PROXY_URL_LENGTH = 4_096;
const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:"]);

function invalidProxyConfiguration(detail) {
  const error = new Error(`Invalid residential media proxy configuration: ${detail}`);
  error.code = "ERR_MEDIA_PROXY_CONFIG";
  return error;
}

/**
 * Validates the proxy once, when this module loads, and returns only the
 * credential-free URI plus the pre-built authorization header. Keeping the
 * original URL out of either agent prevents debug/error output (and the
 * https-proxy-agent `proxy` event) from exposing residential-proxy secrets.
 *
 * A configured-but-invalid value throws instead of silently downloading from
 * the host's direct IP. An unset/empty variable intentionally disables proxy
 * routing for local development.
 */
function parseProxyConfiguration(value, variableName) {
  if (value == null || value === "") return null;

  const raw = String(value).trim();
  if (!raw) throw invalidProxyConfiguration(`${variableName} is blank`);
  if (raw.length > MAX_PROXY_URL_LENGTH) {
    throw invalidProxyConfiguration(`${variableName} exceeds ${MAX_PROXY_URL_LENGTH} characters`);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    // Do not attach the URL parser's error as a cause: ERR_INVALID_URL keeps
    // the rejected input (including credentials) on its `input` property.
    throw invalidProxyConfiguration(`${variableName} must be an absolute http:// or https:// URL`);
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw invalidProxyConfiguration(
      `${variableName} uses unsupported protocol ${
        parsed.protocol || "(missing)"
      }; use http:// or https://`
    );
  }
  if (!parsed.hostname) throw invalidProxyConfiguration(`${variableName} requires a hostname`);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw invalidProxyConfiguration(
      `${variableName} does not support paths, query strings, or fragments`
    );
  }

  let username;
  let password;
  try {
    username = decodeURIComponent(parsed.username || "");
    password = decodeURIComponent(parsed.password || "");
  } catch {
    throw invalidProxyConfiguration(`${variableName} credentials use invalid percent-encoding`);
  }

  parsed.username = "";
  parsed.password = "";
  const uri = parsed.toString().replace(/\/$/, "");
  const token =
    username || password
      ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
      : null;

  return Object.freeze({ uri, token });
}

function loadProxyConfiguration(environment) {
  const preferred = parseProxyConfiguration(
    environment.RESIDENTIAL_PROXY_URL,
    "RESIDENTIAL_PROXY_URL"
  );
  const legacy = parseProxyConfiguration(environment.MEDIA_PROXY_URL, "MEDIA_PROXY_URL");
  if (
    preferred &&
    legacy &&
    (preferred.uri !== legacy.uri || preferred.token !== legacy.token)
  ) {
    throw invalidProxyConfiguration(
      "RESIDENTIAL_PROXY_URL and MEDIA_PROXY_URL resolve to different proxies"
    );
  }
  return preferred || legacy;
}

const proxyConfiguration = loadProxyConfiguration(process.env);

let undiciAgent = null;
let nodeAgent = null;

export function mediaProxyEnabled() {
  return Boolean(proxyConfiguration);
}

function createUndiciProxyAgent({ connectTimeoutMs } = {}) {
  const options = proxyConfiguration.token
    ? { uri: proxyConfiguration.uri, token: proxyConfiguration.token }
    : { uri: proxyConfiguration.uri };
  if (Number.isSafeInteger(connectTimeoutMs) && connectTimeoutMs > 0) {
    options.connectTimeout = connectTimeoutMs;
  }
  try {
    return new ProxyAgent(options);
  } catch {
    throw invalidProxyConfiguration("could not initialize the fetch proxy agent");
  }
}

/** Dispatcher for global fetch() calls that should go through the proxy. */
export function mediaDispatcher() {
  if (!proxyConfiguration) return undefined;
  if (!undiciAgent) undiciAgent = createUndiciProxyAgent();
  return undiciAgent;
}

/** Agent for node http/https requests that should go through the proxy. */
export function mediaAgent() {
  if (!proxyConfiguration) return undefined;
  if (!nodeAgent) {
    // Give the agent a credential-free URL. Supplying Proxy-Authorization as
    // an agent-only CONNECT header keeps it away from destination requests.
    const options = proxyConfiguration.token
      ? { headers: { "Proxy-Authorization": proxyConfiguration.token } }
      : undefined;
    try {
      nodeAgent = new HttpsProxyAgent(proxyConfiguration.uri, options);
    } catch {
      throw invalidProxyConfiguration("could not initialize the Node proxy agent");
    }
  }
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

/**
 * Creates an isolated streaming client for one download (including all of its
 * redirects), so timeout/error teardown cannot terminate unrelated
 * video-relay requests or concurrent jobs.
 */
export function createMediaRequestScope(options = {}) {
  if (!proxyConfiguration) return null;
  const dispatcher = createUndiciProxyAgent(options);
  return Object.freeze({
    close: () => dispatcher.close(),
    destroy: (error) => dispatcher.destroy(error),
    request: (url, options = {}) => undiciRequest(url, { ...options, dispatcher }),
  });
}
