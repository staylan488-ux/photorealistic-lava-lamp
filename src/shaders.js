(function (global) {
  'use strict';

  const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // Single fullscreen triangle covering [-1, 1]
  vec2 pos = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

  const SCENE_FRAG_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

#define BLOB_COUNT 26
#define PI 3.14159265359

uniform vec2 uResolution;
uniform float uTime;
uniform float uSimTime;

// Camera
uniform vec3 uCamPos;
uniform vec3 uCamTarget;
uniform float uFov;

// Physics blob data
uniform vec4 uBlobsPosRad[BLOB_COUNT]; // xyz = center, w = radius
uniform vec4 uBlobsMeta[BLOB_COUNT];   // x = temp, y = stretchY, z = phase, w = role

// Appearance & controls
uniform vec3 uWaxColor;       // Linear base wax pigment
uniform vec3 uLiquidColor;    // Linear liquid tint
uniform vec3 uGlowColor;      // Linear incandescent core glow color
uniform float uHeat;          // Effective bulb & heater intensity [0..1.35]
uniform float uBulbOcclusion; // Live shadow factor from wax over bulb
uniform float uWaxCenterY;    // Live vertical center of glowing wax
uniform int uMetalType;       // 0: Aluminum, 1: Copper, 2: Obsidian, 3: Brass
uniform int uRoomMood;        // 0: Night Desk, 1: Warm Dusk, 2: Studio
uniform int uQuality;         // 0: Eco, 1: Balanced, 2: Ultra

// Shared physical constants (matching physics.js exactly)
const float BOTTLE_Y_MIN = 1.02;
const float BOTTLE_Y_MAX = 3.44;
const float LIQUID_Y_MIN = 1.075;
const float LIQUID_Y_MAX = 3.285;
const float WALL_THICKNESS = 0.028;
const vec3 BULB_POS = vec3(0.0, 0.90, 0.0);

// -----------------------------------------------------------------------------
// Math & Procedural Noise Utilities
// -----------------------------------------------------------------------------
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i + vec2(0.0, 0.0)), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm2D(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 4; i++) {
    v += a * noise2D(p);
    p = rot * p * 2.04 + vec2(13.7, 7.3);
    a *= 0.5;
  }
  return v;
}

// Fast smooth 3D trigonometric organic density (gyroid FBM)
float gyroid3D(vec3 p) {
  return dot(sin(p), cos(p.yzx));
}

float waxMarbling(vec3 p) {
  vec3 q = p * 5.2 + vec3(0.0, -uSimTime * 0.14, 0.0);
  float g1 = gyroid3D(q);
  float g2 = gyroid3D(q * 2.15 + vec3(1.7, g1 * 0.45, -2.3));
  return 0.5 + 0.5 * clamp((g1 * 0.62 + g2 * 0.38) * 0.45, -1.0, 1.0);
}

float sminCubic(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * h * k * (1.0 / 6.0);
}

float smaxCubic(float a, float b, float k) {
  return -sminCubic(-a, -b, k);
}

float smaxQuad(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return max(a, b) + h * h * k * 0.25;
}

// -----------------------------------------------------------------------------
// Exact Iconic Mathmos Astro Lamp Lathe Profiles
// -----------------------------------------------------------------------------
float bottleOuterRadius(float y) {
  float u = clamp((y - BOTTLE_Y_MIN) / (BOTTLE_Y_MAX - BOTTLE_Y_MIN), 0.0, 1.0);
  float upperTaper = 0.635 - 0.380 * pow(u, 0.96);
  float bottomTuck = 0.125 * exp(-u * 13.0);
  float belly = 0.018 * sin(u * PI);
  return upperTaper - bottomTuck + belly;
}

float bottleInnerRadius(float y) {
  float u = clamp((y - BOTTLE_Y_MIN) / (BOTTLE_Y_MAX - BOTTLE_Y_MIN), 0.0, 1.0);
  float extraBaseGlass = 0.008 * exp(-u * 9.0);
  return max(0.05, bottleOuterRadius(y) - WALL_THICKNESS - extraBaseGlass);
}

// Hourglass spun-aluminum pedestal base (y in [0.0, 1.095])
float baseOuterRadius(float y) {
  float rLower = mix(0.595, 0.335, (y - 0.015) / (0.62 - 0.015));
  float rUpper = mix(0.335, 0.548, (y - 0.62) / (1.095 - 0.62));
  float r = smaxQuad(rLower, rUpper, 0.055);
  // Subtle recessed felt/rubber foot shadow groove at the very bottom
  float footIndent = 0.018 * (1.0 - smoothstep(0.0, 0.026, y));
  // Subtle machined seam ring at the waist (y = 0.62)
  float waistGroove = 0.0035 * exp(-pow((y - 0.62) / 0.012, 2.0));
  return r - footIndent - waistGroove;
}

float sdBase(vec3 p) {
  float rXZ = length(p.xz);
  float rProf = baseOuterRadius(clamp(p.y, 0.0, 1.095));
  float dSide = (rXZ - rProf) * 0.84;
  float dVert = max(-p.y + 0.002, p.y - 1.095);
  float dOuter = smaxCubic(dSide, dVert, 0.012);

  // Subtle recessed upper cradle socket where the glass bottle seats into the metal
  float dSocket = max(rXZ - (bottleOuterRadius(p.y) + 0.002), 1.04 - p.y);
  return max(dOuter, -dSocket);
}

// Tapered spun-metal cap (y in [3.355, 3.94])
float capOuterRadius(float y) {
  float t = clamp((y - 3.355) / (3.94 - 3.355), 0.0, 1.0);
  // Smooth taper with very subtle convex fullness near the crown
  return mix(0.280, 0.208, t) + 0.004 * sin(t * PI);
}

float sdCap(vec3 p) {
  float rXZ = length(p.xz);
  float rProf = capOuterRadius(p.y);
  float dSide = (rXZ - rProf) * 0.90;
  // Slightly domed crown top
  float domeY = 3.94 + 0.014 * (1.0 - clamp((rXZ * rXZ) / (0.21 * 0.21), 0.0, 1.0));
  float dVert = max(3.355 - p.y, p.y - domeY);
  return smaxCubic(dSide, dVert, 0.014);
}

float sdMetal(vec3 p) {
  return min(sdBase(p), sdCap(p));
}

float sdGlassOuter(vec3 p) {
  float rXZ = length(p.xz);
  float rProf = bottleOuterRadius(p.y);
  float dSide = (rXZ - rProf) * 0.88;
  float dVert = max(BOTTLE_Y_MIN - p.y, p.y - BOTTLE_Y_MAX);
  return smaxCubic(dSide, dVert, 0.025);
}

// Submerged stainless-steel surface-tension heating coil sitting inside the bottom glass
float sdHeatingCoil(vec3 p) {
  if (p.y > 1.19 || p.y < 1.05) return 0.5;
  float angle = atan(p.z, p.x);
  float R = 0.34;
  float springWave = 0.005 * sin(angle * 36.0);
  vec2 q = vec2(length(p.xz) - R, p.y - 1.095 + springWave);
  return length(q) - (0.014 + 0.0025 * cos(angle * 36.0));
}

// Combined outer opaque + glass scene SDF (returns vec2(dist, matId): 1.0=metal, 2.0=glass)
vec2 mapOuterScene(vec3 p) {
  float dM = sdMetal(p);
  float dG = sdGlassOuter(p);
  if (dM < dG) {
    return vec2(dM, 1.0);
  }
  return vec2(dG, 2.0);
}

// -----------------------------------------------------------------------------
// 3D Organic Deformable Wax Metaball Field
// -----------------------------------------------------------------------------
// Fast SDF only (for thickness / shadow rays & normals)
float mapWaxDist(vec3 p) {
  // Subtle slow organic surface undulation so large blobs never feel geometrically rigid
  float ripple = 0.0045 * sin(p.x * 8.5 + uSimTime * 0.55) * cos(p.y * 6.5 - uSimTime * 0.42) * sin(p.z * 8.5 + uSimTime * 0.48);

  // Cohesive heated bottom wax cushion hugging the glass base & coil
  float poolUndulate = 0.018 * sin(p.x * 5.0 + uSimTime * 0.45) * cos(p.z * 5.0 - uSimTime * 0.38);
  float poolHeight = LIQUID_Y_MIN + 0.068 + 0.018 * clamp(uHeat, 0.0, 1.2) + poolUndulate;
  float dPool = p.y - poolHeight;
  // Slightly domed in center when warm
  float rXZ = length(p.xz);
  dPool += rXZ * rXZ * 0.14;

  float d = dPool;
  const float blendK = 0.155;

  for (int i = 0; i < BLOB_COUNT; i++) {
    vec4 pr = uBlobsPosRad[i];
    vec3 q = p - pr.xyz;
    // Fast bounding sphere reject for distant blobs
    float approx = length(q) - pr.w * 1.65;
    if (approx > d + blendK) continue;

    float stretchY = uBlobsMeta[i].y;
    float invSqrtS = inversesqrt(max(stretchY, 0.35));
    vec3 rVec = vec3(pr.w * invSqrtS, pr.w * stretchY, pr.w * invSqrtS);
    vec3 qDivR = q / rVec;
    float k0 = length(qDivR) + 1e-5;
    float k1 = length(qDivR / rVec) + 1e-5 / max(pr.w, 0.02);
    float dBlob = k0 * (k0 - 1.0) / k1;

    d = sminCubic(d, dBlob, blendK);
  }

  d += ripple;

  // Confine smoothly inside glass cavity so touching blobs flatten authentically against glass
  float innerR = bottleInnerRadius(p.y) - 0.005;
  float dWall = rXZ - innerR;
  float dBot = LIQUID_Y_MIN - p.y;
  float dTop = p.y - (LIQUID_Y_MAX - 0.012);
  float dCavity = max(dWall, max(dBot, dTop));
  return smaxCubic(d, dCavity, 0.022);
}

// Full wax evaluation returning vec2(dist, smoothlyBlendedTemperature)
vec2 mapWaxFull(vec3 p) {
  float ripple = 0.0045 * sin(p.x * 8.5 + uSimTime * 0.55) * cos(p.y * 6.5 - uSimTime * 0.42) * sin(p.z * 8.5 + uSimTime * 0.48);

  float poolUndulate = 0.018 * sin(p.x * 5.0 + uSimTime * 0.45) * cos(p.z * 5.0 - uSimTime * 0.38);
  float poolHeight = LIQUID_Y_MIN + 0.068 + 0.018 * clamp(uHeat, 0.0, 1.2) + poolUndulate;
  float rXZ = length(p.xz);
  float dPool = (p.y - poolHeight) + rXZ * rXZ * 0.14;

  float d = dPool;
  const float blendK = 0.155;

  // Pool base temperature (hottest right over central bulb)
  float poolTemp = clamp((0.68 + 0.28 * exp(-rXZ * rXZ * 4.5)) * min(1.15, uHeat + 0.1), 0.05, 1.0);
  float wPool = 1.0 / pow(max(dPool, 0.0) + 0.055, 3.0);
  float tempSum = poolTemp * wPool;
  float wSum = wPool;

  for (int i = 0; i < BLOB_COUNT; i++) {
    vec4 pr = uBlobsPosRad[i];
    vec4 meta = uBlobsMeta[i];
    vec3 q = p - pr.xyz;

    float stretchY = meta.y;
    float invSqrtS = inversesqrt(max(stretchY, 0.35));
    vec3 rVec = vec3(pr.w * invSqrtS, pr.w * stretchY, pr.w * invSqrtS);
    vec3 qDivR = q / rVec;
    float k0 = length(qDivR) + 1e-5;
    float k1 = length(qDivR / rVec) + 1e-5 / max(pr.w, 0.02);
    float dBlob = k0 * (k0 - 1.0) / k1;

    d = sminCubic(d, dBlob, blendK);

    float w = 1.0 / pow(max(dBlob, 0.0) + 0.055, 3.0);
    tempSum += meta.x * w;
    wSum += w;
  }

  d += ripple;

  float innerR = bottleInnerRadius(p.y) - 0.005;
  float dWall = rXZ - innerR;
  float dBot = LIQUID_Y_MIN - p.y;
  float dTop = p.y - (LIQUID_Y_MAX - 0.012);
  float dCavity = max(dWall, max(dBot, dTop));

  return vec2(smaxCubic(d, dCavity, 0.022), tempSum / max(wSum, 1e-5));
}

// Analytical tetrahedron normals
vec3 calcMetalNormal(vec3 p) {
  const vec2 e = vec2(0.0012, -0.0012);
  return normalize(
    e.xyy * sdMetal(p + e.xyy) +
    e.yyx * sdMetal(p + e.yyx) +
    e.yxy * sdMetal(p + e.yxy) +
    e.xxx * sdMetal(p + e.xxx)
  );
}

vec3 calcGlassNormal(vec3 p) {
  const vec2 e = vec2(0.0014, -0.0014);
  return normalize(
    e.xyy * sdGlassOuter(p + e.xyy) +
    e.yyx * sdGlassOuter(p + e.yyx) +
    e.yxy * sdGlassOuter(p + e.yxy) +
    e.xxx * sdGlassOuter(p + e.xxx)
  );
}

vec3 calcWaxNormal(vec3 p) {
  const vec2 e = vec2(0.0022, -0.0022);
  return normalize(
    e.xyy * mapWaxDist(p + e.xyy) +
    e.yyx * mapWaxDist(p + e.yyx) +
    e.yxy * mapWaxDist(p + e.yxy) +
    e.xxx * mapWaxDist(p + e.xxx)
  );
}

// -----------------------------------------------------------------------------
// Studio / Room HDRI Environment & Mood Lighting
// -----------------------------------------------------------------------------
float getMoodExposure() {
  if (uRoomMood == 1) return 1.45; // Warm Dusk
  if (uRoomMood == 2) return 2.25; // Bright Studio
  return 0.62;                     // Night Desk (dramatic moody contrast)
}

// Rich procedural studio HDRI sampled by glass & brushed metal reflections
vec3 sampleStudioEnv(vec3 dir) {
  float expMul = getMoodExposure();

  // Base architectural room vertical gradient
  vec3 ceilCol, horizCol, floorCol;
  if (uRoomMood == 1) {
    // Warm Dusk
    ceilCol  = vec3(0.045, 0.038, 0.055);
    horizCol = vec3(0.115, 0.082, 0.072);
    floorCol = vec3(0.032, 0.022, 0.017);
  } else if (uRoomMood == 2) {
    // Architectural Studio
    ceilCol  = vec3(0.11, 0.125, 0.145);
    horizCol = vec3(0.16, 0.165, 0.175);
    floorCol = vec3(0.055, 0.045, 0.038);
  } else {
    // Night Desk (Cozy Dark Room)
    ceilCol  = vec3(0.012, 0.015, 0.024);
    horizCol = vec3(0.030, 0.028, 0.036);
    floorCol = vec3(0.012, 0.009, 0.008);
  }

  vec3 col = dir.y >= 0.0
    ? mix(horizCol, ceilCol, pow(clamp(dir.y, 0.0, 1.0), 0.65))
    : mix(horizCol, floorCol, pow(clamp(-dir.y, 0.0, 1.0), 0.55));

  // Tall soft vertical window / softbox key light (front-left) — creates iconic crisp curved glass specular ribbons!
  vec3 keyDir = normalize(vec3(-0.74, 0.28, 0.61));
  float keyAz = abs(atan(dir.x, dir.z) - atan(keyDir.x, keyDir.z));
  keyAz = min(keyAz, 2.0 * PI - keyAz);
  float windowHoriz = smoothstep(0.26, 0.04, keyAz);
  float windowVert  = smoothstep(-0.48, 0.02, dir.y) * smoothstep(0.80, 0.52, dir.y);
  // Subtle window mullion bar across the tall softbox for unmistakable photographic realism!
  float mullion = 1.0 - 0.48 * exp(-pow((dir.y - 0.30) / 0.024, 2.0));
  vec3 keyTint = (uRoomMood == 1) ? vec3(1.16, 0.91, 0.73) : vec3(0.88, 0.94, 1.06);
  col += keyTint * windowHoriz * windowVert * mullion * 1.75 * expMul;

  // Secondary tall thin rim strip (back-right) — carves crisp right-side glass & metal silhouette!
  vec3 rimDir = normalize(vec3(0.82, 0.24, -0.52));
  float rimAz = abs(atan(dir.x, dir.z) - atan(rimDir.x, rimDir.z));
  rimAz = min(rimAz, 2.0 * PI - rimAz);
  float rimHoriz = smoothstep(0.18, 0.03, rimAz);
  float rimVert  = smoothstep(-0.45, 0.06, dir.y) * smoothstep(0.82, 0.55, dir.y);
  vec3 rimTint = (uRoomMood == 2) ? vec3(0.95, 0.96, 1.0) : vec3(1.12, 0.85, 0.66);
  col += rimTint * rimHoriz * rimVert * 1.15 * expMul;

  // Warm directional tabletop reflection seen by downward-facing brushed metal (smoothly windowed, zero horizon seam!)
  float deskMask = smoothstep(0.04, -0.10, dir.y);
  if (deskMask > 0.001) {
    float deskBand = exp(-pow(dir.y + 0.34, 2.0) * 4.8) * deskMask;
    vec3 lampDeskTint = mix(uWaxColor, uGlowColor, 0.48);
    // Directional reflections on the desk give the upper metal cradle crisp dark-and-bright metallic contrast!
    float tableKeyStrip = smoothstep(0.42, 0.04, keyAz) * 0.95 * expMul;
    float tableRimStrip = smoothstep(0.34, 0.04, rimAz) * 0.65 * expMul;
    float warmRing = (0.14 + 0.22 * (smoothstep(0.75, 0.1, keyAz) + smoothstep(0.75, 0.1, rimAz))) * clamp(uHeat, 0.0, 1.35);
    col += (keyTint * tableKeyStrip + rimTint * tableRimStrip + lampDeskTint * warmRing) * deskBand;
  }

  // Overhead soft ceiling bounce highlight (gives metal cap dome a real photographic highlight)
  float topSpot = pow(max(0.0, dot(dir, normalize(vec3(-0.18, 0.96, 0.20)))), 14.0);
  col += vec3(0.82, 0.88, 1.0) * topSpot * 0.58 * expMul;

  // Subtle warm room bounce radiated by the lava lamp itself onto the surrounding room
  float wallGlow = smoothstep(-0.45, 0.35, dir.y) * smoothstep(0.85, 0.05, dir.y);
  vec3 lampAmbientColor = mix(uWaxColor, uGlowColor, 0.35);
  col += lampAmbientColor * wallGlow * (0.045 + 0.075 * uHeat) * (1.1 - 0.35 * uBulbOcclusion);

  return col;
}

// Smooth radial wall & dark studio background seen behind the lamp (with live lamp glow cast onto back wall!)
vec3 shadeBackground(vec3 ro, vec3 rd) {
  // Compute closest approach of camera ray to the lamp axis (x=0, y=uWaxCenterY, z=0) for realistic soft wall wash!
  vec3 lampGlowCenter = vec3(0.0, mix(1.75, uWaxCenterY, 0.65), 0.0);
  float tClosest = max(0.0, dot(lampGlowCenter - ro, rd));
  vec3 closestPt = ro + rd * tClosest;
  float radialDist = length(closestPt - lampGlowCenter);

  // Soft warm glow projected by the lamp onto the dark matte wall behind it
  float wallWash = exp(-radialDist * radialDist * 0.135);
  float upperFade = smoothstep(0.70, -0.05, rd.y);
  vec3 lampEmitCol = mix(uWaxColor, uGlowColor, 0.40);
  float lampPower = clamp(uHeat, 0.0, 1.35) * (1.05 - 0.28 * uBulbOcclusion);

  // Keep backdrop calm, photographic, velvety smooth studio gradient
  vec3 baseWall;
  if (uRoomMood == 1) {
    baseWall = mix(vec3(0.036, 0.027, 0.030), vec3(0.015, 0.013, 0.020), clamp(rd.y * 1.7 + 0.25, 0.0, 1.0));
  } else if (uRoomMood == 2) {
    baseWall = mix(vec3(0.088, 0.092, 0.102), vec3(0.048, 0.054, 0.066), clamp(rd.y * 1.6 + 0.28, 0.0, 1.0));
  } else {
    baseWall = mix(vec3(0.012, 0.011, 0.015), vec3(0.005, 0.006, 0.010), clamp(rd.y * 1.7 + 0.28, 0.0, 1.0));
  }

  // Ultra-subtle matte plaster grain
  float wallTex = 0.96 + 0.05 * noise2D(rd.xy * 18.0);
  vec3 col = baseWall * wallTex;
  col += lampEmitCol * wallWash * upperFade * 0.21 * lampPower;

  return col;
}

// -----------------------------------------------------------------------------
// PBR Spun Metal Shading (Anisotropic Concentric Lathe Brushing)
// -----------------------------------------------------------------------------
float distributionGGX(float NdotH, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-5);
}

float geometrySchlickGGX(float NdotV, float rough) {
  float r = rough + 1.0;
  float k = (r * r) / 8.0;
  return NdotV / max(NdotV * (1.0 - k) + k, 1e-5);
}

vec3 fresnelSchlickRough(float cosTheta, vec3 F0, float rough) {
  return F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

vec3 shadeMetal(vec3 p, vec3 n, vec3 v) {
  // Material parameters per finish
  vec3 albedo;
  float metallic;
  float baseRough;
  if (uMetalType == 1) {
    // Spun Rose Copper
    albedo = vec3(0.93, 0.56, 0.42);
    metallic = 0.96;
    baseRough = 0.23;
  } else if (uMetalType == 2) {
    // Anodized Matte Obsidian
    albedo = vec3(0.11, 0.115, 0.128);
    metallic = 0.62;
    baseRough = 0.34;
  } else if (uMetalType == 3) {
    // Satin Champagne Brass
    albedo = vec3(0.89, 0.74, 0.44);
    metallic = 0.95;
    baseRough = 0.24;
  } else {
    // Classic Mathmos Spun Silver Aluminum
    albedo = vec3(0.85, 0.87, 0.90);
    metallic = 0.96;
    baseRough = 0.22;
  }

  // Fine concentric lathe-turning micro-grooves around Y axis
  float angle = atan(p.z, p.x);
  float grooveFine = sin(p.y * 520.0 + sin(angle * 3.0) * 0.4) * 0.5 + 0.5;
  float grooveBroad = noise2D(vec2(p.y * 85.0, 2.5));
  float brushPattern = mix(grooveFine, grooveBroad, 0.45);
  float rough = clamp(baseRough + (brushPattern - 0.5) * 0.08, 0.12, 0.65);

  // Subtle concentric normal perturbation (stretches reflections vertically like real spun metal!)
  vec3 tangY = normalize(vec3(0.0, 1.0, 0.0) - n * n.y);
  vec3 nBrushed = normalize(n + tangY * (brushPattern - 0.5) * 0.065);

  float NdotV = max(dot(nBrushed, v), 0.001);
  vec3 F0 = mix(vec3(0.04), albedo, metallic);

  // Anisotropic-blurred environment reflection (averaged along vertical lathe tangent)
  vec3 rMain = reflect(-v, nBrushed);
  vec3 rUp   = normalize(reflect(-v, normalize(nBrushed + tangY * (rough * 0.38))));
  vec3 rDown = normalize(reflect(-v, normalize(nBrushed - tangY * (rough * 0.38))));
  vec3 envRefl = (sampleStudioEnv(rMain) * 0.50 + sampleStudioEnv(rUp) * 0.25 + sampleStudioEnv(rDown) * 0.25);

  // Direct studio key & rim GGX highlights
  vec3 col = vec3(0.0);
  float expMul = getMoodExposure();

  // Key softbox light (front-left)
  {
    vec3 L = normalize(vec3(-0.72, 0.36, 0.59));
    vec3 H = normalize(L + v);
    float NdotL = max(dot(nBrushed, L), 0.0);
    float NdotH = max(dot(nBrushed, H), 0.0);
    float D = distributionGGX(NdotH, rough);
    float G = geometrySchlickGGX(NdotV, rough) * geometrySchlickGGX(NdotL, rough);
    vec3 F = fresnelSchlickRough(max(dot(H, v), 0.0), F0, rough);
    vec3 spec = (D * G * F) / max(4.0 * NdotV * NdotL, 0.001);
    vec3 kD = (1.0 - F) * (1.0 - metallic);
    vec3 lCol = ((uRoomMood == 1) ? vec3(1.15, 0.90, 0.72) : vec3(0.90, 0.95, 1.05)) * 1.45 * expMul;
    col += (kD * albedo / PI + spec) * lCol * NdotL;
  }

  // Rim light (back-right)
  {
    vec3 L = normalize(vec3(0.80, 0.30, -0.50));
    vec3 H = normalize(L + v);
    float NdotL = max(dot(nBrushed, L), 0.0);
    float NdotH = max(dot(nBrushed, H), 0.0);
    float D = distributionGGX(NdotH, rough * 1.05);
    float G = geometrySchlickGGX(NdotV, rough) * geometrySchlickGGX(NdotL, rough);
    vec3 F = fresnelSchlickRough(max(dot(H, v), 0.0), F0, rough);
    vec3 spec = (D * G * F) / max(4.0 * NdotV * NdotL, 0.001);
    vec3 kD = (1.0 - F) * (1.0 - metallic);
    vec3 lCol = vec3(1.08, 0.86, 0.68) * 1.05 * expMul;
    col += (kD * albedo / PI + spec) * lCol * NdotL;
  }

  // Environment IBL reflection + subtle diffuse ambient
  vec3 F_env = fresnelSchlickRough(NdotV, F0, rough);
  vec3 diffuseIBL = (1.0 - F_env) * (1.0 - metallic) * albedo * sampleStudioEnv(n) * 0.45;
  col += diffuseIBL + envRefl * F_env * (1.0 - rough * 0.32);

  // --- Physical Warm Glow Spill From the Lava Bottle Onto Metal Base & Cap ---
  vec3 lampColor = mix(uWaxColor, uGlowColor, 0.52);
  float lampPower = clamp(uHeat, 0.0, 1.35) * (1.05 - 0.22 * uBulbOcclusion);

  if (p.y < 1.2) {
    // Upper base cradle lip catches crisp warm hairline glow right where glass seats into metal
    float nearLip = exp(-max(0.0, 1.095 - p.y) * 9.5);
    float upwardFacing = clamp(nBrushed.y * 0.55 + 0.48, 0.0, 1.0);
    float rimGlow = exp(-abs(p.y - 1.088) * 32.0) * 0.92;
    // Lower skirt catches subtle warm bounce reflected off the walnut tabletop
    float tableBounce = exp(-p.y * 3.0) * clamp(-nBrushed.y * 0.4 + 0.55, 0.0, 1.0);
    // Scaled by metal F0/albedo so dark obsidian stays sleek dark metal while silver/copper/brass gleam!
    vec3 metalTint = mix(albedo, vec3(1.0), 0.10) * lampColor;
    col += metalTint * (nearLip * upwardFacing * 0.42 + rimGlow * 0.55 + tableBounce * 0.16) * lampPower;

    // Contact AO right where base meets the walnut tabletop
    float footAO = smoothstep(0.0, 0.055, p.y);
    col *= mix(0.24, 1.0, footAO);
  } else {
    // Top cap underside rim catches subtle upward warm glow from the upper bottle!
    float nearBottomCap = exp(-max(0.0, p.y - 3.355) * 6.5);
    float downFacing = clamp(-nBrushed.y * 0.7 + 0.35, 0.0, 1.0);
    float capRim = exp(-abs(p.y - 3.362) * 36.0) * 0.65;
    vec3 capBounce = mix(albedo, vec3(1.0), 0.2) * mix(uWaxColor, uGlowColor, 0.30);
    col += capBounce * (nearBottomCap * downFacing * 0.38 + capRim * 0.55) * lampPower;
  }

  return col;
}

// -----------------------------------------------------------------------------
// Photorealistic Dark Oiled Walnut Wood Tabletop (with Live Lamp Glow & Reflection)
// -----------------------------------------------------------------------------
void evalWalnutWood(vec2 xz, out vec3 albedo, out float rough, out vec3 normal) {
  // Fine-fibered solid American walnut grain elongated smoothly along X (subtle, zero zebra stripes!)
  float macroWarp = fbm2D(vec2(xz.x * 0.28, xz.y * 0.65) + vec2(3.1, 1.7));
  float cathedral = 0.5 + 0.5 * sin((xz.y * 3.2 + macroWarp * 3.8) * 2.4);
  cathedral = smoothstep(0.15, 0.88, cathedral);

  // Fine straight hardwood grain fibers & micro-pores
  float streak1 = noise2D(vec2(xz.x * 1.4, xz.y * 19.0 + macroWarp * 5.5));
  float streak2 = noise2D(vec2(xz.x * 3.6, xz.y * 54.0 + macroWarp * 9.0));
  float fineGrain = streak1 * 0.62 + streak2 * 0.38;
  float pores = smoothstep(0.74, 0.94, noise2D(vec2(xz.x * 8.0, xz.y * 115.0)));

  // Rich, restrained oiled walnut espresso palette (linear space)
  vec3 woodDark = vec3(0.014, 0.0088, 0.0060);
  vec3 woodMid  = vec3(0.029, 0.0165, 0.0100);
  vec3 woodWarm = vec3(0.044, 0.0245, 0.0135);

  albedo = mix(woodDark, woodMid, fineGrain * 0.72 + cathedral * 0.28);
  albedo = mix(albedo, woodWarm, cathedral * fineGrain * 0.38);
  albedo *= (1.0 - pores * 0.24);

  // Subtle hand-oiled satin varnish finish: glossy on smooth timber, matte in tiny pores
  rough = clamp(0.16 + pores * 0.20 + (1.0 - fineGrain) * 0.07, 0.13, 0.55);

  // Very subtle fine-grain micro-normal for crisp satin highlights
  float bumpZ = (streak2 - 0.5) * 0.014 - pores * 0.022;
  float bumpX = (noise2D(vec2((xz.x + 0.03) * 3.6, xz.y * 54.0 + macroWarp * 9.0)) - streak2) * 0.16;
  normal = normalize(vec3(bumpX, 1.0, bumpZ));
}

// Fast proxy reflection of the glowing lamp seen in the glossy walnut tabletop
vec3 traceLampTableReflection(vec3 ro, vec3 rd) {
  // Quick bounding cylinder check (r < 0.72, y in [0, 4.0])
  float a = dot(rd.xz, rd.xz);
  float b = 2.0 * dot(ro.xz, rd.xz);
  float c = dot(ro.xz, ro.xz) - 0.68 * 0.68;
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0 || a < 1e-6) {
    return sampleStudioEnv(rd);
  }
  float tNear = max(0.02, (-b - sqrt(disc)) / (2.0 * a));
  float tFar  = (-b + sqrt(disc)) / (2.0 * a);
  if (tFar < 0.02) return sampleStudioEnv(rd);

  float t = tNear;
  for (int i = 0; i < 18; i++) {
    vec3 p = ro + rd * t;
    if (p.y > 4.05 || t > tFar + 0.15) break;
    float dM = sdMetal(p);
    float dG = sdGlassOuter(p);
    if (dM < 0.012 && dM <= dG) {
      vec3 nM = calcMetalNormal(p);
      return shadeMetal(p, nM, -rd);
    }
    if (dG < 0.015) {
      // Sample glowing lamp interior quickly along reflection ray!
      vec3 pMid = p + rd * 0.28;
      float dW = mapWaxDist(pMid);
      float hNorm = clamp((p.y - LIQUID_Y_MIN) / (LIQUID_Y_MAX - LIQUID_Y_MIN), 0.0, 1.0);
      float bulbFalloff = exp(-hNorm * 1.9);
      float waxPresence = smoothstep(0.18, -0.04, dW);
      vec3 glowCol = mix(uWaxColor * 1.4, uGlowColor * 2.4, bulbFalloff * 0.72);
      vec3 liqGlow = mix(uLiquidColor * 0.22, uGlowColor * 0.85, bulbFalloff * 0.65);
      vec3 interior = mix(liqGlow, glowCol, 0.35 + 0.65 * waxPresence) * clamp(uHeat, 0.0, 1.35);
      vec3 nG = calcGlassNormal(p);
      float F = 0.04 + 0.96 * pow(1.0 - max(dot(-rd, nG), 0.0), 5.0);
      return mix(interior, sampleStudioEnv(reflect(rd, nG)), F);
    }
    t += max(0.025, min(dM, dG) * 0.92);
  }
  return sampleStudioEnv(rd);
}

vec3 shadeTabletop(vec3 p, vec3 ro, vec3 rd) {
  vec3 albedo;
  float rough;
  vec3 n;
  evalWalnutWood(p.xz, albedo, rough, n);

  vec3 v = -rd;
  float distOrigin = length(p.xz);
  float expMul = getMoodExposure();

  // Contact Ambient Occlusion directly beneath the lamp base (base radius ~ 0.595)
  float baseAO = smoothstep(0.54, 0.88, distOrigin);
  baseAO = mix(0.08, 1.0, baseAO * baseAO);

  // Soft studio key-light shadow cast by the lamp silhouette onto the desk
  vec3 keyDir = normalize(vec3(-0.72, 0.56, 0.40));
  float tShad = dot(-p.xz, keyDir.xz) / max(dot(keyDir.xz, keyDir.xz), 1e-4);
  float shadow = 1.0;
  if (tShad > 0.0 && tShad < 5.5) {
    vec3 sp = p + keyDir * tShad;
    float rLamp = (sp.y < 1.08) ? baseOuterRadius(clamp(sp.y, 0.0, 1.08)) :
                  (sp.y < 3.40) ? bottleOuterRadius(sp.y) : capOuterRadius(clamp(sp.y, 3.36, 3.94));
    float dAxis = length(sp.xz);
    float sBand = smoothstep(rLamp * 0.72, rLamp * 1.48 + tShad * 0.14, dAxis);
    // Glass bottle casts a slightly softer translucent shadow than the opaque metal base
    float opacity = (sp.y < 1.08 || sp.y > 3.36) ? 0.82 : 0.42;
    shadow = mix(1.0 - opacity, 1.0, sBand);
  }

  // Room studio diffuse + specular lighting on wood
  vec3 col = vec3(0.0);
  {
    float NdotL = max(dot(n, keyDir), 0.0);
    vec3 H = normalize(keyDir + v);
    float NdotV = max(dot(n, v), 0.001);
    float NdotH = max(dot(n, H), 0.0);
    float D = distributionGGX(NdotH, rough);
    float G = geometrySchlickGGX(NdotV, rough) * geometrySchlickGGX(NdotL, rough);
    vec3 F = fresnelSchlickRough(max(dot(H, v), 0.0), vec3(0.04), rough);
    vec3 spec = (D * G * F) / max(4.0 * NdotV * NdotL, 0.001);
    vec3 lCol = ((uRoomMood == 1) ? vec3(1.12, 0.88, 0.70) : vec3(0.88, 0.94, 1.04)) * 0.65 * expMul;
    col += (albedo / PI + spec * 0.65) * lCol * NdotL * shadow;
  }

  // Soft ambient room bounce
  vec3 ambEnv = (uRoomMood == 2) ? vec3(0.14, 0.145, 0.155) :
                (uRoomMood == 1) ? vec3(0.065, 0.048, 0.042) :
                                   vec3(0.022, 0.023, 0.028);
  col += albedo * ambEnv * baseAO;

  // --- Glowing Lava Lamp Light Pool & Subtle Shifting Caustics on the Walnut Desk ---
  float lampPower = clamp(uHeat, 0.0, 1.35) * (1.08 - 0.25 * uBulbOcclusion);
  vec3 lampGlowCenter = vec3(0.0, mix(1.55, uWaxCenterY, 0.55), 0.0);
  vec3 toLamp = lampGlowCenter - p;
  float dLamp = length(toLamp);
  vec3 L_lamp = toLamp / max(dLamp, 1e-4);

  // The opaque spun-metal base blocks direct bottle light right next to the foot,
  // creating an authentic physical shadow collar transitioning into a warm glowing halo!
  float coneClearance = smoothstep(0.60, 1.18, distOrigin);
  // Subtle warm light leak right at the tabletop reflection ring
  float atten = 1.0 / (1.0 + dLamp * dLamp * 0.36);

  // Subtle organic animated caustic shimmer across the desk surface from moving wax blobs
  float angle = atan(p.z, p.x);
  float causticWave = 0.88 + 0.16 * sin(angle * 3.0 + uSimTime * 0.45 + distOrigin * 1.4)
                           * cos(angle * 2.0 - uSimTime * 0.32);

  vec3 lampPoolColor = mix(uWaxColor, uGlowColor, 0.45);
  float NdotLamp = max(dot(n, L_lamp), 0.0);

  // Diffuse warm pool on walnut wood
  col += albedo * lampPoolColor * atten * NdotLamp * coneClearance * causticWave * 2.85 * lampPower;

  // Glossy specular sheen of the lamp across the oiled wood grain
  {
    vec3 H = normalize(L_lamp + v);
    float NdotV = max(dot(n, v), 0.001);
    float NdotH = max(dot(n, H), 0.0);
    float D = distributionGGX(NdotH, rough * 1.18);
    float G = geometrySchlickGGX(NdotV, rough * 1.18) * geometrySchlickGGX(NdotLamp, rough * 1.18);
    vec3 F = fresnelSchlickRough(max(dot(H, v), 0.0), vec3(0.048), rough);
    vec3 spec = (D * G * F) / max(4.0 * NdotV * NdotLamp, 0.001);
    col += spec * lampPoolColor * atten * NdotLamp * coneClearance * 1.75 * lampPower;
  }

  // --- Real-Time Mirror-Rough Reflection of the Lamp in the Oiled Walnut Desk ---
  float NdotV = max(dot(n, v), 0.001);
  vec3 F_table = fresnelSchlickRough(NdotV, vec3(0.045), rough);
  vec3 reflDir = reflect(-v, n);
  vec3 reflCol;
  if (distOrigin < 4.5 && reflDir.y > 0.0) {
    reflCol = traceLampTableReflection(p + vec3(0.0, 0.005, 0.0), reflDir);
  } else {
    reflCol = sampleStudioEnv(reflDir);
  }
  col += reflCol * F_table * (0.85 - rough * 0.55) * mix(0.32, 1.0, baseAO);

  // Soft 50mm f/2.0 depth-of-field distance falloff blending desk seamlessly into room backdrop
  float distCam = length(p - ro);
  float fog = smoothstep(3.4, 10.2, distCam);
  vec3 fogCol = shadeBackground(ro, rd);
  col = mix(col, fogCol, fog);

  return col;
}

// -----------------------------------------------------------------------------
// Photorealistic Subsurface Wax Shading (Volumetric Optical Depth + Self-Shadow)
// -----------------------------------------------------------------------------
vec3 shadeWax(vec3 p, vec3 n, vec3 rdLiq, float temp) {
  vec3 v = -rdLiq;
  float bulbPower = clamp(uHeat, 0.0, 1.35);

  // Physical Beer-Lambert chromatic absorption coefficient derived from wax pigment!
  // Thin/hot wax shifts naturally toward incandescent uGlowColor; thick cool cores deepen richly.
  vec3 safeWax = clamp(uWaxColor, vec3(0.015), vec3(0.99));
  vec3 sigmaWax = max(vec3(0.18), 1.0 - pow(safeWax, vec3(0.72))) * 3.85;

  // Organic internal paraffin marbling modulates optical density slightly
  float marble = waxMarbling(p);
  float densityMod = mix(0.84, 1.18, marble);

  // 1. Light-march toward the incandescent bottom bulb:
  //    Simultaneously computes local self-thickness AND real-time soft translucent shadows from lower blobs!
  vec3 toBulb = BULB_POS - p;
  float distBulb = length(toBulb);
  vec3 L_bulb = toBulb / max(distBulb, 1e-4);

  float waxDepthBulb = 0.0;
  float bulbMarchMax = min(distBulb - 0.06, 1.45);
  int shadowSteps = (uQuality == 0) ? 5 : 8;
  float stepLen = bulbMarchMax / float(shadowSteps);

  for (int i = 0; i < 8; i++) {
    if (i >= shadowSteps) break;
    float sDist = (float(i) + 0.45) * stepLen;
    vec3 sp = p + L_bulb * sDist;
    if (sp.y < LIQUID_Y_MIN) break;
    float dW = mapWaxDist(sp);
    // Smooth volumetric optical thickness integration (inside wax dW < 0)
    float insideWeight = smoothstep(0.035, -0.065, dW);
    waxDepthBulb += insideWeight * stepLen * densityMod;
  }

  // 2. View-ray internal thickness probe (makes stretched necks & thin blob edges glow incandescent!)
  float viewThick = 0.0;
  float probeDists[4] = float[4](0.028, 0.075, 0.145, 0.245);
  float probeWeights[4] = float[4](0.045, 0.065, 0.095, 0.125);
  for (int i = 0; i < 4; i++) {
    vec3 sp = p + rdLiq * probeDists[i];
    float dW = mapWaxDist(sp);
    viewThick += smoothstep(0.02, -0.05, dW) * probeWeights[i];
  }
  float thinness = exp(-viewThick * 5.2); // 1.0 at thin pinching necks/edges, ~0.18 at thick blob cores

  // Inverse-square tungsten bulb irradiance: sculpted molten gold core at center, vivid saturated shoulders
  float hNorm = clamp((p.y - LIQUID_Y_MIN) / (LIQUID_Y_MAX - LIQUID_Y_MIN), 0.0, 1.0);
  float rHoriz = length(p.xz);
  float filamentFocus = 0.62 + 0.52 * exp(-rHoriz * rHoriz * 5.8);
  float bulbAtten = filamentFocus / (0.28 + distBulb * distBulb * 1.08);

  // Chromatic Beer-Lambert transmission through the wax from the incandescent bulb!
  vec3 transBulb = exp(-sigmaWax * (waxDepthBulb * 2.15 + viewThick * 0.45));

  // Forward-scattered glowing bulb core (strongest on bottom-lit faces & thin stretched necks!)
  float wrapNdotL = clamp((dot(n, L_bulb) + 0.56) / 1.56, 0.0, 1.0);
  float backlitLobe = pow(clamp(dot(-v, L_bulb) * 0.5 + 0.5, 0.0, 1.0), 1.8);
  vec3 bulbLightColor = mix(uGlowColor, vec3(1.0, 0.96, 0.86), 0.16 * exp(-hNorm * 3.0) * filamentFocus);

  vec3 sssDirect = bulbLightColor * transBulb * bulbAtten * (0.42 + 1.05 * wrapNdotL + 0.68 * backlitLobe * thinness) * 1.18 * bulbPower;

  // Hot incandescent thin-edge & bottom-coil internal scatter (preserves rich molten 3D depth!)
  float hotness = clamp(temp * 0.72 + (1.0 - hNorm) * 0.30, 0.0, 1.0);
  vec3 internalGlow = mix(safeWax * 1.18, uGlowColor * 1.42, clamp(thinness * 0.58 + hotness * 0.46, 0.0, 1.0));
  vec3 sssCore = internalGlow * exp(-sigmaWax * (waxDepthBulb * 0.78 + 0.16)) * (0.30 + 0.74 * thinness) * bulbAtten * 0.92 * bulbPower;

  // Deep velvety body color for cooler thick upper wax blobs so they look weighty & sculpted, never flat!
  float upperCoolness = smoothstep(0.15, 0.92, hNorm);
  vec3 deepBody = safeWax * mix(vec3(0.24, 0.14, 0.18), vec3(0.45), 0.35) * (0.35 + 0.65 * marble);
  // Subtle ambient studio key light entering through the glass bottle onto the wax surface
  vec3 keyDir = normalize(vec3(-0.72, 0.38, 0.58));
  float keyWrap = clamp((dot(n, keyDir) + 0.42) / 1.42, 0.0, 1.0);
  float expMul = getMoodExposure();
  vec3 roomScatter = safeWax * (0.06 + 0.14 * keyWrap * expMul) * (0.45 + 0.55 * upperCoolness);
  // Soft cool top bounce on upper wax domes
  roomScatter += deepBody * clamp(n.y * 0.5 + 0.5, 0.0, 1.0) * (0.08 + 0.12 * expMul);

  // Subtle low-contrast submerged waxy sheen (IOR_wax 1.44 in IOR_liq 1.34 -> tiny F0 ~ 0.002!)
  // Keeps wax looking authentically velvety & organic instead of shiny CGI plastic!
  float NdotV = max(dot(n, v), 0.001);
  float waxRim = pow(1.0 - NdotV, 3.2);
  vec3 H_key = normalize(keyDir + v);
  float specKey = pow(max(dot(n, H_key), 0.0), 18.0) * 0.065 * expMul;
  vec3 H_bulb = normalize(L_bulb + v);
  float specBulb = pow(max(dot(n, H_bulb), 0.0), 12.0) * bulbAtten * 0.11 * bulbPower * exp(-waxDepthBulb * 3.0);

  // Translucent velvety rim glow catching ambient liquid scatter around the blob silhouette
  vec3 rimSSS = mix(safeWax, uGlowColor, 0.48) * waxRim * (0.28 + 0.55 * bulbAtten * bulbPower) * exp(-waxDepthBulb * 1.15);

  vec3 color = sssDirect + sssCore + roomScatter + rimSSS + vec3(specKey) + bulbLightColor * specBulb;

  // When dimmer is off (uHeat ~ 0), wax sits cool & solid in room light
  color += deepBody * (1.0 - min(1.0, bulbPower * 2.0)) * (0.25 + 0.35 * keyWrap) * max(0.35, expMul);

  return color;
}

// -----------------------------------------------------------------------------
// Tiny Suspended Micro-Bubbles / Thermal Convection Motes in the Clear Fluid
// -----------------------------------------------------------------------------
float evalMicroBubbles(vec3 p) {
  // Sparse 3D lattice drifting gently upward with thermal convection
  vec3 drift = vec3(
    sin(p.y * 2.0 + uSimTime * 0.18) * 0.04,
    -uSimTime * 0.055,
    cos(p.y * 2.2 - uSimTime * 0.15) * 0.04
  );
  vec3 q = (p + drift) * 14.5;
  vec3 id = floor(q);
  vec3 f = fract(q) - 0.5;
  vec3 rnd = hash33(id);
  // Only ~14% of cells contain a subtle micro-bubble
  if (rnd.z < 0.86) return 0.0;
  vec3 offset = (rnd - 0.5) * 0.62;
  float d = length(f - offset);
  float size = 0.032 + 0.038 * fract(rnd.x * 17.3);
  return smoothstep(size, size * 0.25, d);
}

// -----------------------------------------------------------------------------
// Complete Dual-Wall Glass Bottle Optics + Volumetric Fluid + Wax Raymarcher
// -----------------------------------------------------------------------------
vec3 traceBottleInterior(vec3 pEntry, vec3 nOut, vec3 rd) {
  float cosI = clamp(dot(-rd, nOut), 0.0, 1.0);
  // Outer soda-lime glass Fresnel (IOR 1.51 -> F0 = 0.041)
  float F_out = 0.041 + (1.0 - 0.041) * pow(1.0 - cosI, 5.0);

  // Outer glass reflection: crisp studio windows + subtle curved key GGX sheen
  vec3 reflDir = reflect(rd, nOut);
  vec3 outerRefl = sampleStudioEnv(reflDir);
  // Subtle crisp studio specular streak on outer glass
  vec3 keyDir = normalize(vec3(-0.72, 0.36, 0.59));
  vec3 H_key = normalize(keyDir - rd);
  float glassSpec = pow(max(dot(nOut, H_key), 0.0), 220.0) * 2.8 * getMoodExposure();
  vec3 rimDir = normalize(vec3(0.80, 0.30, -0.50));
  vec3 H_rim = normalize(rimDir - rd);
  glassSpec += pow(max(dot(nOut, H_rim), 0.0), 180.0) * 1.4 * getMoodExposure();
  outerRefl += vec3(0.95, 0.97, 1.0) * glassSpec;

  // Refract air (1.0) -> soda-lime glass (1.51)
  vec3 rdGlass = refract(rd, nOut, 1.0 / 1.51);
  if (length(rdGlass) < 0.001) rdGlass = rd;
  rdGlass = normalize(rdGlass);

  // Step smoothly through the solid glass wall with exact binary bisection on wall crossing
  // (eliminates any discrete step banding along the curved glass rim!)
  float wallStep = 0.0065;
  float sCurr = 0.003;
  float sPrev = 0.0;
  vec3 pWall = pEntry + rdGlass * sCurr;
  bool enteredLiquid = false;
  float glassPath = sCurr;

  for (int i = 0; i < 16; i++) {
    float rXZ = length(pWall.xz);
    float innerR = bottleInnerRadius(pWall.y);
    if (rXZ < innerR && pWall.y > LIQUID_Y_MIN - 0.02 && pWall.y < BOTTLE_Y_MAX - 0.04) {
      // Exact 4-step bisection onto the continuous inner glass boundary
      float lo = sPrev;
      float hi = sCurr;
      for (int b = 0; b < 4; b++) {
        float mid = 0.5 * (lo + hi);
        vec3 pm = pEntry + rdGlass * mid;
        if (length(pm.xz) < bottleInnerRadius(pm.y)) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      glassPath = hi;
      pWall = pEntry + rdGlass * hi;
      enteredLiquid = true;
      break;
    }
    if (rXZ > bottleOuterRadius(pWall.y) + 0.004 || pWall.y < BOTTLE_Y_MIN || pWall.y > BOTTLE_Y_MAX) {
      // Exact 4-step bisection onto outer glass exit boundary for smooth grazing glass rim
      float lo = sPrev;
      float hi = sCurr;
      for (int b = 0; b < 4; b++) {
        float mid = 0.5 * (lo + hi);
        vec3 pm = pEntry + rdGlass * mid;
        if (length(pm.xz) > bottleOuterRadius(pm.y)) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      glassPath = 0.5 * (lo + hi);
      pWall = pEntry + rdGlass * glassPath;
      break;
    }
    sPrev = sCurr;
    sCurr += wallStep;
    pWall = pEntry + rdGlass * sCurr;
    glassPath = sCurr;
  }

  float bulbPower = clamp(uHeat, 0.0, 1.35);
  // Subtle soda-lime glass absorption (classic ultra-faint cool greenish crystal edge tint)
  vec3 glassTint = exp(-vec3(0.24, 0.07, 0.11) * glassPath * 5.0);

  // --- CASE B: Grazing Glass Wall Rim Path (Smooth luminous crystal bottle edge!) ---
  if (!enteredLiquid) {
    vec3 nExit = calcGlassNormal(pWall);
    vec3 rdExit = refract(rdGlass, -nExit, 1.51);
    vec3 rdRefl = reflect(rdGlass, -nExit);
    float exitValid = smoothstep(0.0, 0.05, length(rdExit));
    rdExit = normalize(mix(rdRefl, rdExit, exitValid));

    vec3 bgCol;
    if (rdExit.y < -0.001) {
      float tFloor = -pWall.y / rdExit.y;
      bgCol = (tFloor > 0.0 && tFloor < 18.0)
        ? shadeTabletop(pWall + rdExit * tFloor, pWall, rdExit)
        : shadeBackground(pWall, rdExit);
    } else {
      bgCol = shadeBackground(pWall, rdExit);
    }

    // Real thick blown glass acts as an optical waveguide piping warm glowing lamp light up the rim!
    float hNorm = clamp((pEntry.y - LIQUID_Y_MIN) / (LIQUID_Y_MAX - LIQUID_Y_MIN), 0.0, 1.0);
    float edgeGlowStrength = (0.28 + 0.95 * exp(-hNorm * 2.1)) * bulbPower * (1.0 - 0.22 * uBulbOcclusion);
    vec3 pipeColor = mix(uWaxColor, uGlowColor, 0.52 + 0.30 * (1.0 - hNorm));
    vec3 rimTransmit = bgCol * glassTint + pipeColor * edgeGlowStrength * 0.44 * glassTint;
    return mix(rimTransmit, outerRefl, clamp(F_out * 1.08, 0.0, 0.95));
  }

  // --- CASE A: Ray Enters Inner Liquid Cavity ---
  // Refract glass (1.51) -> fluid (1.34)
  vec3 nWallSurf = calcGlassNormal(pWall);
  vec3 rdLiq = refract(rdGlass, nWallSurf, 1.51 / 1.34);
  if (length(rdLiq) < 0.001) rdLiq = rdGlass;
  rdLiq = normalize(rdLiq);

  // Beer-Lambert optical absorption coefficient of the clear / tinted fluid
  vec3 safeLiq = clamp(uLiquidColor, vec3(0.04), vec3(0.995));
  vec3 sigmaLiq = -log(safeLiq) * 0.95 + vec3(0.06, 0.07, 0.08);

  int maxSteps = (uQuality == 0) ? 56 : ((uQuality == 1) ? 84 : 112);
  float t = 0.004;
  float maxT = 1.38;

  bool hitWax = false;
  bool hitCoil = false;
  bool crossedMeniscus = false;
  vec3 pHit = pWall;
  float waxTemp = 0.5;
  float prevT = 0.0;

  // Accumulated volumetric fluid glow (Tyndall / Mie incandescent scattering + micro-bubbles)
  vec3 volGlow = vec3(0.0);
  vec3 liqTrans = vec3(1.0);

  for (int i = 0; i < 112; i++) {
    if (i >= maxSteps || t > maxT) break;
    vec3 p = pWall + rdLiq * t;

    float rXZ = length(p.xz);
    float innerR = bottleInnerRadius(p.y);

    // Exited inner liquid cavity? Bisect exact back inner glass boundary for seamless grazing optics!
    if (rXZ > innerR + 0.002 || p.y < LIQUID_Y_MIN - 0.015 || p.y > BOTTLE_Y_MAX - 0.035) {
      float tLo = prevT;
      float tHi = t;
      for (int b = 0; b < 3; b++) {
        float tMid = 0.5 * (tLo + tHi);
        vec3 pm = pWall + rdLiq * tMid;
        if (length(pm.xz) > bottleInnerRadius(pm.y) || pm.y < LIQUID_Y_MIN - 0.015 || pm.y > BOTTLE_Y_MAX - 0.035) {
          tHi = tMid;
        } else {
          tLo = tMid;
        }
      }
      float tExit = 0.5 * (tLo + tHi);
      float fracStep = max(0.0, tExit - prevT);
      liqTrans *= exp(-sigmaLiq * fracStep);
      pHit = pWall + rdLiq * tExit;
      break;
    }

    // Subtle top liquid meniscus air-gap boundary right below the metal cap (y ~ 3.285)
    float prevY = (p - rdLiq * max(t - prevT, 0.012)).y;
    if (!crossedMeniscus && ((prevY < LIQUID_Y_MAX && p.y >= LIQUID_Y_MAX) || (prevY > LIQUID_Y_MAX && p.y <= LIQUID_Y_MAX))) {
      crossedMeniscus = true;
      // Bright curved surface-tension meniscus ring catching warm internal glow!
      float menEdge = smoothstep(0.0, 0.92, rXZ / max(innerR, 0.05));
      vec3 menCol = mix(uWaxColor, uGlowColor, 0.52) * (0.20 + 0.42 * menEdge) * bulbPower;
      volGlow += liqTrans * menCol;
    }

    float dWax = mapWaxDist(p);
    float dCoil = (p.y < 1.18) ? sdHeatingCoil(p) : 1.0;

    if (dWax < 0.0016) {
      // 2-step binary bisection refinement for razor-smooth liquid paraffin silhouettes!
      float tLo = prevT;
      float tHi = t;
      for (int b = 0; b < 3; b++) {
        float tMid = 0.5 * (tLo + tHi);
        if (mapWaxDist(pWall + rdLiq * tMid) < 0.0) {
          tHi = tMid;
        } else {
          tLo = tMid;
        }
      }
      pHit = pWall + rdLiq * (0.5 * (tLo + tHi));
      vec2 wFull = mapWaxFull(pHit);
      waxTemp = wFull.y;
      hitWax = true;
      break;
    }

    if (dCoil < 0.0018) {
      hitCoil = true;
      pHit = p;
      break;
    }

    // Accurate sphere-trace step (no oversized min floor -> silky grazing blob silhouettes!)
    float stepD = clamp(min(dWax, dCoil) * 0.82, 0.0012, 0.034);

    // Volumetric incandescent fluid glow along this liquid segment (only below meniscus)
    if (p.y < LIQUID_Y_MAX) {
      float distBulb = length(p - BULB_POS);
      float hNorm = clamp((p.y - LIQUID_Y_MIN) / (LIQUID_Y_MAX - LIQUID_Y_MIN), 0.0, 1.0);
      // Warm incandescent light shaft radiating up from the bulb through clear fluid
      float shaft = exp(-rXZ * rXZ * (3.2 - hNorm * 1.4)) / (0.16 + distBulb * distBulb * 1.55);
      // Soft halo bloom where light skims closely past glowing wax
      float waxHalo = exp(-max(dWax, 0.0) * 9.0) * 0.36;
      // Dynamic attenuation by wax sitting near bottom
      float occMod = mix(1.0, 0.62, uBulbOcclusion * smoothstep(0.05, 0.55, hNorm));

      vec3 scatterTint = mix(uLiquidColor, uGlowColor, 0.55 * exp(-hNorm * 1.45));
      vec3 glowAdd = scatterTint * (shaft * 0.36 * occMod + waxHalo * (0.22 + 0.72 * exp(-hNorm * 1.5))) * bulbPower;

      // Tiny sparkling micro-bubbles drifting in the warm fluid (suppressed near extreme grazing glass rim)
      if (uQuality >= 1 && dWax > 0.015 && rXZ < innerR - 0.018) {
        float bubble = evalMicroBubbles(p);
        if (bubble > 0.01) {
          glowAdd += mix(uGlowColor, vec3(1.0, 0.98, 0.92), 0.55) * bubble * (0.55 + 2.0 * shaft) * bulbPower * 3.2;
        }
      }

      volGlow += liqTrans * glowAdd * stepD;
      liqTrans *= exp(-sigmaLiq * stepD);
    }

    prevT = t;
    t += stepD;
  }

  vec3 interiorColor = vec3(0.0);

  if (hitWax) {
    vec3 nWax = calcWaxNormal(pHit);
    vec3 waxCol = shadeWax(pHit, nWax, rdLiq, waxTemp);
    interiorColor = volGlow + liqTrans * waxCol;
  } else if (hitCoil) {
    // Glowing stainless-steel heating spring submerged right over the tungsten bulb
    vec3 coilCol = mix(vec3(0.35, 0.32, 0.30), uGlowColor * 2.2, clamp(bulbPower * 0.92, 0.0, 1.0));
    interiorColor = volGlow + liqTrans * coilCol;
  } else {
    // Ray reached the back inner glass wall — smoothly refract out into background room & desk!
    vec3 nBack = calcGlassNormal(pHit);
    float backCos = clamp(dot(-rdLiq, -nBack), 0.0, 1.0);
    float F_back = 0.03 + 0.97 * pow(1.0 - backCos, 5.0);

    vec3 rdReflBack = reflect(rdLiq, -nBack);
    vec3 rdExitRaw = refract(rdLiq, -nBack, 1.34);
    // Smooth continuous transition near Total Internal Reflection angle (zero edge pixel pops!)
    float tirFactor = smoothstep(0.18, 0.52, backCos) * step(0.001, length(rdExitRaw));
    vec3 rdExit = normalize(mix(rdReflBack, normalize(rdExitRaw + vec3(1e-5)), tirFactor));

    // Sample refracted background room / walnut desk behind the bottle
    vec3 behindCol;
    if (pHit.y <= LIQUID_Y_MIN + 0.01) {
      float rBulb = length(pHit.xz);
      float bulbCore = exp(-rBulb * rBulb * 10.0);
      behindCol = mix(uGlowColor * 1.25, vec3(1.0, 0.95, 0.82) * 3.0, bulbCore) * bulbPower;
    } else if (rdExit.y < -0.002) {
      float tFloor = -pHit.y / rdExit.y;
      behindCol = (tFloor > 0.0 && tFloor < 18.0)
        ? shadeTabletop(pHit + rdExit * tFloor, pHit, rdExit)
        : shadeBackground(pHit, rdExit);
    } else {
      behindCol = shadeBackground(pHit, rdExit);
    }

    // Internal back-wall reflection catches glowing warm lamp light & room studio reflections
    float hBack = clamp((pHit.y - LIQUID_Y_MIN) / (LIQUID_Y_MAX - LIQUID_Y_MIN), 0.0, 1.0);
    vec3 backInternalGlow = mix(uWaxColor, uGlowColor, 0.55) * (0.28 + 0.80 * exp(-hBack * 2.0)) * bulbPower;
    float internalMix = clamp(mix(0.84, F_back * 0.72, tirFactor), 0.0, 0.88);
    vec3 backCombined = mix(behindCol * glassTint, backInternalGlow + sampleStudioEnv(rdReflBack) * 0.35, internalMix);

    interiorColor = volGlow + liqTrans * backCombined;
  }

  // Subtle physical incandescent warmth leaking right around the bottom glass-to-metal junction
  float baseSocketGlow = exp(-max(0.0, pEntry.y - 1.09) * 18.0) * (0.35 + 0.65 * (1.0 - cosI));
  interiorColor += uGlowColor * baseSocketGlow * 0.34 * bulbPower;

  // Apply thin front glass wall tint and blend outer glass Fresnel reflection
  vec3 finalGlass = mix(interiorColor * glassTint, outerRefl, F_out);
  return finalGlass;
}

// -----------------------------------------------------------------------------
// Ray-Cylinder Bounding Volume Intersection (Huge Performance Optimization!)
// -----------------------------------------------------------------------------
bool intersectLampBounds(vec3 ro, vec3 rd, out float tMin, out float tMax) {
  const float R = 0.68;
  float a = dot(rd.xz, rd.xz);
  float b = 2.0 * dot(ro.xz, rd.xz);
  float c = dot(ro.xz, ro.xz) - R * R;

  float t0 = 0.0;
  float t1 = 100.0;
  if (a > 1e-6) {
    float disc = b * b - 4.0 * a * c;
    if (disc < 0.0) return false;
    float sq = sqrt(disc);
    t0 = (-b - sq) / (2.0 * a);
    t1 = (-b + sq) / (2.0 * a);
  } else if (c > 0.0) {
    return false;
  }

  // Intersect vertical slab y in [-0.02, 4.04]
  if (abs(rd.y) > 1e-6) {
    float ty0 = (-0.02 - ro.y) / rd.y;
    float ty1 = (4.04 - ro.y) / rd.y;
    if (ty0 > ty1) {
      float tmp = ty0; ty0 = ty1; ty1 = tmp;
    }
    t0 = max(t0, ty0);
    t1 = min(t1, ty1);
  } else if (ro.y < -0.02 || ro.y > 4.04) {
    return false;
  }

  tMin = max(0.001, t0);
  tMax = t1;
  return tMax > tMin;
}

// -----------------------------------------------------------------------------
// Main Entry Point
// -----------------------------------------------------------------------------
void main() {
  vec2 ndc = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  ndc.x *= aspect;

  // Build camera basis
  vec3 cw = normalize(uCamTarget - uCamPos);
  vec3 cu = normalize(cross(cw, vec3(0.0, 1.0, 0.0)));
  vec3 cv = cross(cu, cw);
  float fl = 1.0 / tan(radians(uFov) * 0.5);
  vec3 rd = normalize(cu * ndc.x + cv * ndc.y + cw * fl);
  vec3 ro = uCamPos;

  // Tabletop analytical intersection distance
  float tFloor = (rd.y < -0.0005) ? (-ro.y / rd.y) : 1e6;
  if (tFloor < 0.0) tFloor = 1e6;

  // Raymarch lamp outer bounding volume if intersected
  float tLampHit = 1e6;
  float hitMat = 0.0;
  float tMin, tMax;

  if (intersectLampBounds(ro, rd, tMin, tMax)) {
    float t = tMin;
    float tLimit = min(tMax + 0.02, tFloor);
    for (int i = 0; i < 64; i++) {
      if (t > tLimit) break;
      vec3 p = ro + rd * t;
      vec2 res = mapOuterScene(p);
      if (res.x < 0.0012) {
        tLampHit = t;
        hitMat = res.y;
        break;
      }
      t += res.x * 0.92;
    }
  }

  vec3 color;
  if (hitMat > 0.5 && tLampHit < tFloor) {
    vec3 pHit = ro + rd * tLampHit;
    if (hitMat < 1.5) {
      // Spun metal base or cap
      vec3 nM = calcMetalNormal(pHit);
      color = shadeMetal(pHit, nM, -rd);
    } else {
      // Dual-wall refractive glass bottle + volumetric fluid + subsurface wax
      vec3 nG = calcGlassNormal(pHit);
      color = traceBottleInterior(pHit, nG, rd);
    }
  } else if (tFloor < 18.0) {
    vec3 pFloor = ro + rd * tFloor;
    color = shadeTabletop(pFloor, ro, rd);
  } else {
    color = shadeBackground(ro, rd);
  }

  // Clamp NaNs/Infs safely while preserving HDR dynamic range for bloom
  color = max(color, vec3(0.0));
  color = min(color, vec3(16.0));
  fragColor = vec4(color, 1.0);
}
`;

  // ---------------------------------------------------------------------------
  // Post-Processing Pass 1: Soft-Knee HDR Bright Extraction
  // ---------------------------------------------------------------------------
  const BRIGHT_FRAG_SHADER = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSceneTex;
uniform float uThreshold;
uniform float uSoftKnee;

void main() {
  // 4-tap box downsample filter to prevent shimmering specular aliasing in bloom
  vec2 texel = 1.0 / vec2(textureSize(uSceneTex, 0));
  vec3 c = (
    texture(uSceneTex, vUv + vec2(-0.5, -0.5) * texel).rgb +
    texture(uSceneTex, vUv + vec2( 0.5, -0.5) * texel).rgb +
    texture(uSceneTex, vUv + vec2(-0.5,  0.5) * texel).rgb +
    texture(uSceneTex, vUv + vec2( 0.5,  0.5) * texel).rgb
  ) * 0.25;

  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float knee = uThreshold * uSoftKnee;
  float soft = clamp(lum - uThreshold + knee, 0.0, 2.0 * knee);
  soft = (soft * soft) / max(4.0 * knee, 1e-5);
  float contrib = max(soft, lum - uThreshold) / max(lum, 1e-5);

  fragColor = vec4(c * contrib, 1.0);
}
`;

  // ---------------------------------------------------------------------------
  // Post-Processing Pass 2: 9-Tap Separable Gaussian Blur
  // ---------------------------------------------------------------------------
  const BLUR_FRAG_SHADER = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uInputTex;
uniform vec2 uDirection; // (1/w, 0) or (0, 1/h)

void main() {
  vec3 sum = texture(uInputTex, vUv).rgb * 0.2270270270;
  sum += texture(uInputTex, vUv + uDirection * 1.3846153846).rgb * 0.3162162162;
  sum += texture(uInputTex, vUv - uDirection * 1.3846153846).rgb * 0.3162162162;
  sum += texture(uInputTex, vUv + uDirection * 3.2307692308).rgb * 0.0702702703;
  sum += texture(uInputTex, vUv - uDirection * 3.2307692308).rgb * 0.0702702703;
  fragColor = vec4(sum, 1.0);
}
`;

  // ---------------------------------------------------------------------------
  // Post-Processing Pass 3: ACES Filmic Composite + Optical Halation + Dither
  // ---------------------------------------------------------------------------
  const COMPOSITE_FRAG_SHADER = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSceneTex;
uniform sampler2D uBloomTight;
uniform sampler2D uBloomWide;
uniform float uExposure;
uniform float uBloomIntensity;
uniform float uTime;

// Stephen Hill / Narkowicz fitted ACES Filmic tone mapping (preserves rich molten gold/orange highlights!)
vec3 acesFilmic(vec3 x) {
  const mat3 acesIn = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  const mat3 acesOut = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );
  vec3 v = acesIn * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(acesOut * (a / b), 0.0, 1.0);
}

// Triangular-PDF micro-dither completely removes 8-bit banding in dark shadows
float ditherNoise(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  float n1 = fract((p3.x + p3.y) * p3.z);
  float n2 = fract((p3.y + p3.z) * p3.x + 0.371);
  return (n1 + n2 - 1.0) / 255.0;
}

void main() {
  vec2 centered = vUv - 0.5;
  float r2 = dot(centered, centered);

  // Ultra-subtle 50mm lens edge chromatic dispersion (almost zero at center)
  vec2 caOffset = centered * r2 * 0.0032;
  vec3 scene;
  scene.r = texture(uSceneTex, vUv + caOffset).r;
  scene.g = texture(uSceneTex, vUv).g;
  scene.b = texture(uSceneTex, vUv - caOffset).b;

  // Dual-scale physically-inspired bloom (tight incandescent core + wide lens halation)
  vec3 bTight = texture(uBloomTight, vUv).rgb;
  vec3 bWide  = texture(uBloomWide, vUv).rgb;
  vec3 color = scene + (bTight * 0.48 + bWide * 0.58) * uBloomIntensity;

  // Exposure & ACES Filmic curve
  color *= uExposure;
  color = acesFilmic(color);

  // Subtle photographic optical vignette
  float vig = 1.0 - r2 * 0.48;
  color *= clamp(vig, 0.58, 1.0);

  // sRGB OETF encoding
  color = pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));

  // Subtle filmic dither (eliminates gradient banding in dark studio background)
  color += ditherNoise(gl_FragCoord.xy + fract(uTime) * 19.0) * 1.15;

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

  global.LavaLamp = global.LavaLamp || {};
  global.LavaLamp.Shaders = {
    VERTEX_SHADER,
    SCENE_FRAG_SHADER,
    BRIGHT_FRAG_SHADER,
    BLUR_FRAG_SHADER,
    COMPOSITE_FRAG_SHADER
  };
})(window);
