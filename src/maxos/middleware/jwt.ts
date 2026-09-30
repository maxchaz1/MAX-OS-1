import type { IdentityEnvelope } from '../types';

export class JwtVerificationError extends Error {
  constructor(
    readonly code: 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'EXPIRED_TOKEN' | 'INVALID_SIGNATURE',
    message: string,
  ) {
    super(message);
    this.name = 'JwtVerificationError';
  }
}

/**
 * Extracts and validates a Bearer token from Authorization header.
 * Phase-12 compliance: Verify JWT locally before forwarding to Portal-OS.
 */
export function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader) {
    throw new JwtVerificationError('MISSING_TOKEN', 'Authorization header is missing');
  }
  if (!authHeader.startsWith('Bearer ')) {
    throw new JwtVerificationError('INVALID_TOKEN', 'Authorization header must use Bearer scheme');
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    throw new JwtVerificationError('MISSING_TOKEN', 'Bearer token is empty');
  }
  return token;
}

/**
 * Simple JWT signature verification using base64-decode and HMAC-SHA256.
 * For production, use a proper JWT library (jose, jsonwebtoken, etc.).
 */
export async function verifyJwtSignature(
  token: string,
  secret: string,
): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtVerificationError('INVALID_TOKEN', 'JWT must have 3 parts (header.payload.signature)');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode header
  const headerJson = atob(headerB64);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(headerJson);
  } catch {
    throw new JwtVerificationError('INVALID_TOKEN', 'JWT header is not valid JSON');
  }

  // Decode payload
  const payloadJson = atob(payloadB64);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new JwtVerificationError('INVALID_TOKEN', 'JWT payload is not valid JSON');
  }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === 'number' ? payload.exp : Number.POSITIVE_INFINITY;
  if (exp < now) {
    throw new JwtVerificationError('EXPIRED_TOKEN', `JWT expired at ${new Date(exp * 1000).toISOString()}`);
  }

  // Verify signature using Web Crypto API
  if (header.alg !== 'HS256') {
    throw new JwtVerificationError('INVALID_TOKEN', `Unsupported JWT algorithm: ${header.alg}`);
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const keyData = encoder.encode(secret);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
  const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=+$/, '');
  const providedSignature = signatureB64.replace(/=+$/, '');

  if (expectedSignature !== providedSignature) {
    throw new JwtVerificationError('INVALID_SIGNATURE', 'JWT signature verification failed');
  }

  return payload;
}

/**
 * Validates JWT claims against expected issuer and audience.
 */
export function validateJwtClaims(
  payload: Record<string, unknown>,
  expectedIssuer: string,
  expectedAudience: string,
): void {
  const iss = payload.iss as string | undefined;
  const aud = payload.aud as string | undefined;

  if (iss !== expectedIssuer) {
    throw new JwtVerificationError('INVALID_TOKEN', `JWT issuer mismatch: expected '${expectedIssuer}', got '${iss}'`);
  }

  if (aud !== expectedAudience) {
    throw new JwtVerificationError('INVALID_TOKEN', `JWT audience mismatch: expected '${expectedAudience}', got '${aud}'`);
  }
}

/**
 * Builds an IdentityEnvelope from a verified JWT payload.
 * Phase-12: Forward verified identity unchanged to Portal-OS.
 */
export function buildIdentityFromJwt(payload: Record<string, unknown>): IdentityEnvelope {
  const sub = payload.sub as string | undefined;
  const type = (payload.type as 'user' | 'service' | 'system') ?? 'service';
  const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];

  if (!sub) {
    throw new JwtVerificationError('INVALID_TOKEN', 'JWT payload must contain "sub" claim');
  }

  return {
    credential: sub,
    id: sub,
    type,
    authenticated: true,
    roles: roles.length > 0 ? roles : ['default'],
    attributes: {
      issuer: payload.iss,
      audience: payload.aud,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      ...(typeof payload.attributes === 'object' && payload.attributes !== null
        ? (payload.attributes as Record<string, unknown>)
        : {}),
    },
  };
}

/**
 * Complete JWT verification pipeline: extract, verify, validate claims, build identity.
 * Throws JwtVerificationError on any failure.
 */
export async function verifyJwtToken(
  authHeader: string | undefined,
  secret: string,
  issuer: string,
  audience: string,
): Promise<IdentityEnvelope> {
  const token = extractBearerToken(authHeader);
  const payload = await verifyJwtSignature(token, secret);
  validateJwtClaims(payload, issuer, audience);
  return buildIdentityFromJwt(payload);
}
