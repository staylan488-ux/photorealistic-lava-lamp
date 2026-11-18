(function (global) {
  'use strict';

  const BOTTLE_Y_MIN = 1.02;
  const BOTTLE_Y_MAX = 3.44;
  const LIQUID_Y_MIN = 1.075;
  const LIQUID_Y_MAX = 3.285;
  const WALL_THICKNESS = 0.028;

  // Exact C-infinity smooth Mathmos Astro-inspired bottle outer profile.
  // Matches shaders.js identically so wax never clips glass.
  function bottleOuterRadius(y) {
    const u = Math.max(0.0, Math.min(1.0, (y - BOTTLE_Y_MIN) / (BOTTLE_Y_MAX - BOTTLE_Y_MIN)));
    const upperTaper = 0.635 - 0.380 * Math.pow(u, 0.96);
    const bottomTuck = 0.125 * Math.exp(-u * 13.0);
    const belly = 0.018 * Math.sin(u * Math.PI);
    return upperTaper - bottomTuck + belly;
  }

  function bottleInnerRadius(y) {
    const u = Math.max(0.0, Math.min(1.0, (y - BOTTLE_Y_MIN) / (BOTTLE_Y_MAX - BOTTLE_Y_MIN)));
    const extraBaseGlass = 0.008 * Math.exp(-u * 9.0);
    return Math.max(0.05, bottleOuterRadius(y) - WALL_THICKNESS - extraBaseGlass);
  }

  // Deterministic seeded PRNG for reproducible gorgeous initial compositions
  function createRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const BLOB_COUNT = 26;

  class LavaPhysics {
    constructor() {
      this.blobs = [];
      this.heatPower = 1.0;        // Dimmer/heater power [0..1.35]
      this.smoothedHeat = 1.0;     // Thermal lag of the incandescent bulb & coil
      this.timeScale = 1.0;
      this.simTime = 0.0;
      this.sloshX = 0.0;
      this.sloshZ = 0.0;
      this.sloshVx = 0.0;
      this.sloshVz = 0.0;
      this.swirlEnergy = 0.0;
      this.coldStartActive = false;

      // Packed Float32Arrays uploaded directly as WebGL2 vec4 uniforms
      this.posRadData = new Float32Array(BLOB_COUNT * 4);
      this.metaData = new Float32Array(BLOB_COUNT * 4); // x: temp, y: stretchY, z: phase, w: role

      // Dynamic lighting telemetry for room/tabletop glow sync
      this.bulbOcclusion = 0.35;
      this.waxCenterY = 1.95;

      this._initBlobs(20261118);
      // Pre-warm simulation so the lamp opens mid-convection with organic rising plumes
      this.prewarm(520);
      this._packUniforms();
    }

    _initBlobs(seed) {
      const rand = createRng(seed);
      this.blobs = [];

      // 5 base-pool reservoir lobes (role = 1): stay near bottom coil, gently heave & feed necks
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2.0 + rand() * 0.4;
        const radDist = i === 0 ? 0.03 : 0.14 + rand() * 0.14;
        const baseR = i === 0 ? 0.215 : 0.165 + rand() * 0.035;
        this.blobs.push({
          x: Math.cos(angle) * radDist,
          y: LIQUID_Y_MIN + 0.055 + rand() * 0.055,
          z: Math.sin(angle) * radDist,
          vx: 0,
          vy: 0,
          vz: 0,
          r: baseR,
          temp: 0.72 + rand() * 0.22,
          stretchY: 0.64,
          phase: rand() * Math.PI * 2.0,
          role: 1, // pool anchor
          buoyancyBias: (rand() - 0.5) * 0.05,
          thermalRate: 0.85 + rand() * 0.3,
          orbitDir: rand() > 0.5 ? 1 : -1
        });
      }

      // 6 large primary hero blobs (role = 0) — staggered across all phases of the convection cycle
      const heroHeights = [1.22, 1.58, 2.02, 2.52, 2.94, 3.12];
      const heroTemps = [0.68, 0.86, 0.78, 0.24, 0.32, 0.18];
      for (let i = 0; i < 6; i++) {
        const y = heroHeights[i] + (rand() - 0.5) * 0.10;
        const maxR = Math.max(0.05, bottleInnerRadius(y) - 0.22);
        const angle = (i / 6) * Math.PI * 2.0 + rand() * 0.6;
        const radDist = Math.sqrt(rand()) * maxR * 0.72;
        const r = 0.155 + rand() * 0.048;
        this.blobs.push({
          x: Math.cos(angle) * radDist,
          y,
          z: Math.sin(angle) * radDist,
          vx: (rand() - 0.5) * 0.02,
          vy: (heroTemps[i] - 0.5) * 0.14,
          vz: (rand() - 0.5) * 0.02,
          r,
          temp: heroTemps[i],
          stretchY: 1.05,
          phase: rand() * Math.PI * 2.0,
          role: 0,
          buoyancyBias: (rand() - 0.5) * 0.04,
          // Surface-area-to-volume thermal rate (~ 1/r): larger blobs cycle more majestically
          thermalRate: (0.14 / r) * (0.78 + rand() * 0.44),
          orbitDir: i % 2 === 0 ? 1 : -1
        });
      }

      // 9 medium convective blobs (role = 0) — half rising warm, half sinking cool
      for (let i = 0; i < 9; i++) {
        const t = (i + 0.5) / 9;
        const y = LIQUID_Y_MIN + 0.14 + t * (LIQUID_Y_MAX - LIQUID_Y_MIN - 0.28);
        const r = 0.102 + rand() * 0.042;
        const maxR = Math.max(0.04, bottleInnerRadius(y) - r - 0.04);
        const angle = (i * 2.39996) + rand() * 0.5;
        const radDist = Math.sqrt(rand()) * maxR * 0.85;
        const rising = (i % 2 === 0);
        const temp = rising ? (0.72 + rand() * 0.22) : (0.16 + rand() * 0.22);
        this.blobs.push({
          x: Math.cos(angle) * radDist,
          y,
          z: Math.sin(angle) * radDist,
          vx: (rand() - 0.5) * 0.025,
          vy: (temp - 0.5) * 0.14,
          vz: (rand() - 0.5) * 0.025,
          r,
          temp,
          stretchY: 1.0,
          phase: rand() * Math.PI * 2.0,
          role: 0,
          buoyancyBias: (rand() - 0.5) * 0.045,
          thermalRate: (0.13 / r) * (0.75 + rand() * 0.50),
          orbitDir: rising ? 1 : -1
        });
      }

      // 6 small satellite droplets (role = 2): delicate detached droplets catching the glow
      for (let i = 0; i < 6; i++) {
        const t = (i + 0.3) / 6;
        const y = LIQUID_Y_MIN + 0.20 + t * (LIQUID_Y_MAX - LIQUID_Y_MIN - 0.40);
        const r = 0.056 + rand() * 0.036;
        const maxR = Math.max(0.04, bottleInnerRadius(y) - r - 0.04);
        const angle = rand() * Math.PI * 2.0;
        const radDist = Math.sqrt(rand()) * maxR * 0.9;
        const temp = (i % 2 === 0) ? (0.74 + rand() * 0.20) : (0.18 + rand() * 0.22);
        this.blobs.push({
          x: Math.cos(angle) * radDist,
          y,
          z: Math.sin(angle) * radDist,
          vx: (rand() - 0.5) * 0.02,
          vy: (temp - 0.5) * 0.12,
          vz: (rand() - 0.5) * 0.02,
          r,
          temp,
          stretchY: 1.0,
          phase: rand() * Math.PI * 2.0,
          role: 2,
          buoyancyBias: (rand() - 0.5) * 0.05,
          thermalRate: (0.11 / r) * (0.70 + rand() * 0.55),
          orbitDir: i % 2 === 0 ? 1 : -1
        });
      }
    }

    prewarm(steps) {
      const savedScale = this.timeScale;
      this.timeScale = 1.0;
      for (let i = 0; i < steps; i++) {
        this._substep(1 / 30);
      }
      this.timeScale = savedScale;
    }

    triggerColdStart() {
      // Settle all wax cool & dense at the bottom pool, then let the bulb melt & awaken it
      this.coldStartActive = true;
      for (let i = 0; i < this.blobs.length; i++) {
        const b = this.blobs[i];
        const angle = b.phase * 1.7 + i * 0.85;
        const maxR = Math.max(0.05, bottleInnerRadius(LIQUID_Y_MIN + 0.14) - b.r * 0.78);
        const rad = (i % 5 === 0 ? 0.15 : 0.35 + ((i * 0.37) % 0.6)) * maxR;
        b.x = Math.cos(angle) * rad;
        b.z = Math.sin(angle) * rad;
        b.y = LIQUID_Y_MIN + 0.06 + (i / BLOB_COUNT) * 0.24;
        b.vx = 0;
        b.vy = -0.02;
        b.vz = 0;
        b.temp = 0.08 + (i % 4) * 0.03;
        b.stretchY = 0.66;
      }
      this.smoothedHeat = 0.12;
      if (this.heatPower < 0.85) {
        this.heatPower = 1.05;
      }
    }

    triggerShake(strength = 1.0) {
      const angle = Math.random() * Math.PI * 2.0;
      this.sloshVx += Math.cos(angle) * 1.45 * strength;
      this.sloshVz += Math.sin(angle) * 1.45 * strength;
      this.swirlEnergy = Math.min(2.2, this.swirlEnergy + 1.15 * strength);

      for (let i = 0; i < this.blobs.length; i++) {
        const b = this.blobs[i];
        const mobility = b.role === 1 ? 0.28 : (b.role === 2 ? 1.25 : 0.85);
        const a = Math.atan2(b.z, b.x) + Math.PI * 0.5;
        const rDist = Math.hypot(b.x, b.z);
        b.vx += (Math.cos(angle) * 0.24 + Math.cos(a) * rDist * 0.55) * mobility * strength;
        b.vz += (Math.sin(angle) * 0.24 + Math.sin(a) * rDist * 0.55) * mobility * strength;
        b.vy += (Math.random() - 0.45) * 0.18 * mobility * strength;
      }
    }

    step(dtReal) {
      const clampedDt = Math.min(dtReal, 0.05);
      const scaledDt = clampedDt * this.timeScale;
      if (scaledDt <= 1e-6) return;

      // Fixed-size substeps for rock-solid thermal & surface-tension stability
      const substeps = Math.max(1, Math.min(4, Math.ceil(scaledDt / 0.016)));
      const dt = scaledDt / substeps;
      for (let s = 0; s < substeps; s++) {
        this._substep(dt);
      }
      this._packUniforms();
    }

    _substep(dt) {
      this.simTime += dt;

      // Smooth thermal inertia of the bulb & bottom coil
      const heatLag = this.coldStartActive ? 0.18 : 1.4;
      this.smoothedHeat += (this.heatPower - this.smoothedHeat) * Math.min(1.0, dt * heatLag);
      if (this.coldStartActive && Math.abs(this.smoothedHeat - this.heatPower) < 0.04) {
        this.coldStartActive = false;
      }

      // Damped spring oscillator for fluid slosh after shake
      const sloshK = 14.0;
      const sloshDamp = 2.6;
      this.sloshVx += (-sloshK * this.sloshX - sloshDamp * this.sloshVx) * dt;
      this.sloshVz += (-sloshK * this.sloshZ - sloshDamp * this.sloshVz) * dt;
      this.sloshX += this.sloshVx * dt;
      this.sloshZ += this.sloshVz * dt;
      this.swirlEnergy *= Math.exp(-dt * 1.15);

      const heat = this.smoothedHeat;
      const spanY = LIQUID_Y_MAX - LIQUID_Y_MIN;
      const blobs = this.blobs;
      const n = blobs.length;

      // Neutral buoyancy temperature (around 0.50; rises above, sinks below)
      const neutralTemp = 0.50;

      // 1. Pairwise soft-core repulsion, capillary cohesion & thermal conduction
      for (let i = 0; i < n; i++) {
        const a = blobs[i];
        const massA = a.r * a.r * a.r;

        for (let j = i + 1; j < n; j++) {
          const b = blobs[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dz = b.z - a.z;
          const distSq = dx * dx + dy * dy + dz * dz + 1e-6;
          const dist = Math.sqrt(distSq);
          const sumR = a.r + b.r;

          if (dist < sumR * 1.75) {
            const nx = dx / dist;
            const ny = dy / dist;
            const nz = dz / dist;
            const massB = b.r * b.r * b.r;
            const invTotalM = 1.0 / (massA + massB);

            let force = 0.0;

            // Soft core repulsion keeps merged blobs plump & multi-lobed instead of collapsing
            const coreDist = sumR * 0.68;
            if (dist < coreDist) {
              const overlap = (coreDist - dist) / coreDist;
              force -= overlap * overlap * 0.34;
            } else if (dist < sumR * 1.38) {
              // Gentle capillary surface-tension attraction when temperatures are close
              const tempDiff = Math.abs(a.temp - b.temp);
              const bridge = 1.0 - (dist - coreDist) / (sumR * 0.70);
              const cohesion = Math.max(0.0, 1.0 - tempDiff * 1.9);
              force += bridge * bridge * 0.042 * cohesion;
            }

            // Very gentle thermal conduction only on tight overlap (lets passing blobs keep distinct cycles!)
            if (dist < sumR * 0.92) {
              const contact = 1.0 - dist / (sumR * 0.92);
              const dT = (b.temp - a.temp) * contact * 0.035 * dt;
              a.temp += dT * (massB * invTotalM);
              b.temp -= dT * (massA * invTotalM);
            }

            const fx = nx * force * dt;
            const fy = ny * force * dt;
            const fz = nz * force * dt;

            // Pool anchors move less vertically from collisions
            const wA = (massB * invTotalM) * (a.role === 1 ? 0.35 : 1.0);
            const wB = (massA * invTotalM) * (b.role === 1 ? 0.35 : 1.0);

            a.vx += fx * wA;
            a.vy += fy * wA * (a.role === 1 ? 0.35 : 1.0);
            a.vz += fz * wA;
            b.vx -= fx * wB;
            b.vy -= fy * wB * (b.role === 1 ? 0.35 : 1.0);
            b.vz -= fz * wB;
          }
        }
      }

      // 2. Thermal exchange, Rayleigh-Benard convection, buoyancy & containment
      let occAccum = 0.0;
      let weightedY = 0.0;
      let totalWeight = 0.0;

      for (let i = 0; i < n; i++) {
        const b = blobs[i];
        const yNorm = Math.max(0.0, Math.min(1.0, (b.y - LIQUID_Y_MIN) / spanY));
        const rHoriz = Math.hypot(b.x, b.z);
        const innerR = bottleInnerRadius(b.y);
        const rNorm = Math.min(1.0, rHoriz / Math.max(0.08, innerR));

        // --- Heat transfer (True Full-Height Rayleigh-Benard Limit Cycle) ---
        // Heat enters strictly in the tight bottom coil zone (y < 1.45), is conserved
        // through the insulated middle column so blobs travel full height, and radiates
        // strongly out in the narrow top neck & cap cooling zone (yNorm > 0.72).
        const bottomZone = Math.max(0.0, 1.0 - (b.y - LIQUID_Y_MIN) / 0.36);
        const bottomHeating = heat * bottomZone * bottomZone * (0.72 + 0.45 * Math.exp(-rNorm * rNorm * 2.0)) * 0.24 * b.thermalRate;

        // Upper radiative cooling strictly in upper 28% of the bottle (near cool tapered neck & cap)
        const topZone = Math.max(0.0, (yNorm - 0.70) / 0.30);
        const topCooling = topZone * topZone * 0.26;
        // When lamp dimmer is turned down low, entire bottle cools steadily
        const lowHeatCooling = Math.max(0.0, 0.58 - heat) * 0.16;
        const coolingTarget = 0.07 + 0.04 * Math.min(1.0, heat);
        const cooling = (b.temp - coolingTarget) * (topCooling + lowHeatCooling + 0.0025) * b.thermalRate;

        b.temp += (bottomHeating - cooling) * dt;
        b.temp = Math.max(0.04, Math.min(1.0, b.temp));

        // --- Buoyancy & Convective Plume Forces ---
        if (b.role === 1) {
          // Base-pool lobes gently heave and breathe over the coil, feeding rising plumes
          const targetY = LIQUID_Y_MIN + 0.055 + 0.085 * heat * (0.5 + 0.5 * Math.sin(this.simTime * 0.55 + b.phase));
          const springY = (targetY - b.y) * 1.6;
          const targetRad = i === 0 ? 0.04 : 0.16 + 0.08 * Math.sin(this.simTime * 0.37 + b.phase);
          const angle = b.phase + this.simTime * 0.12 * b.orbitDir;
          const tx = Math.cos(angle) * targetRad;
          const tz = Math.sin(angle) * targetRad;

          b.vx += ((tx - b.x) * 0.45 + this.sloshX * 0.18) * dt;
          b.vz += ((tz - b.z) * 0.45 + this.sloshZ * 0.18) * dt;
          b.vy += springY * dt;

          // Strong viscous damping for heavy base wax pool
          const damp = Math.exp(-dt * 3.8);
          b.vx *= damp;
          b.vy *= damp;
          b.vz *= damp;
        } else {
          // Free convective wax blobs
          const effectiveTemp = b.temp + b.buoyancyBias;
          const deltaT = effectiveTemp - neutralTemp;
          let buoyancy = deltaT * 0.46;

          // Subtle paraffin surface-tension dwell at the bottom pool & top meniscus:
          // Wax gathers heat to ~0.70 before breaking cleanly off the bottom coil,
          // and cools smoothly below ~0.34 before breaking free from the top crown!
          if (yNorm < 0.12 && deltaT > 0.0 && b.temp < 0.72) {
            buoyancy *= 0.18; // swells & builds glowing neck before pinching free!
          }
          if (yNorm > 0.84 && deltaT < 0.0 && b.temp > 0.32) {
            buoyancy *= 0.22; // lingers gracefully at top dome before detaching downward!
          }

          // When heat is very low (dimmer off), wax hardens and settles heavily at the bottom
          const coldGravity = (1.0 - Math.min(1.0, heat * 1.6)) * -0.22;

          // Rayleigh-Benard toroidal circulation:
          // Warm rising wax subtly drifts inward toward the central thermal plume;
          // Cool sinking wax drifts gently outward toward the cooler glass perimeter.
          const radialPref = deltaT > 0.0
            ? -0.042 * deltaT * (0.35 + rNorm)
            : 0.038 * (-deltaT) * (1.0 - rNorm * 0.55);

          const dirX = rHoriz > 1e-4 ? b.x / rHoriz : Math.cos(b.phase);
          const dirZ = rHoriz > 1e-4 ? b.z / rHoriz : Math.sin(b.phase);

          // Gentle organic swirl & fluid currents
          const tangX = -dirZ;
          const tangZ = dirX;
          const swirlSpeed = (0.015 * b.orbitDir + 0.010 * Math.sin(this.simTime * 0.23 + b.phase + yNorm * 3.0))
            + this.swirlEnergy * 0.16 * (0.35 + rNorm);

          // Subtle 3D curl-like wander so paths never feel purely vertical
          const wanderX = Math.sin(this.simTime * 0.29 + b.y * 2.1 + b.phase) * 0.014;
          const wanderZ = Math.cos(this.simTime * 0.26 + b.y * 1.9 + b.phase * 1.4) * 0.014;

          // Slosh wave from interactive shake
          const sloshFactor = (0.3 + 0.7 * yNorm) * 0.45;

          b.vx += (dirX * radialPref + tangX * swirlSpeed + wanderX + this.sloshX * sloshFactor) * dt;
          b.vz += (dirZ * radialPref + tangZ * swirlSpeed + wanderZ + this.sloshZ * sloshFactor) * dt;
          b.vy += (buoyancy + coldGravity) * dt;

          // Viscous Stokes drag (slightly higher viscosity when cool, lower when hot)
          const sizeFactor = 0.14 / Math.max(0.06, b.r);
          const viscosity = (1.42 - 0.35 * b.temp) * (0.78 + 0.22 * sizeFactor);
          const drag = Math.exp(-dt * viscosity);
          b.vx *= drag;
          b.vy *= drag;
          b.vz *= drag;

          // Terminal speed clamp for dreamy, hypnotic real-world wax pacing
          const maxSpeed = 0.32 + this.swirlEnergy * 0.35;
          const speed = Math.hypot(b.vx, b.vy, b.vz);
          if (speed > maxSpeed) {
            const s = maxSpeed / speed;
            b.vx *= s;
            b.vy *= s;
            b.vz *= s;
          }
        }

        // Integrate position
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;

        // --- Analytical Glass Bottle Inner Containment ---
        // Floor containment (glass bottom curve)
        const minY = LIQUID_Y_MIN + b.r * 0.46;
        if (b.y < minY) {
          b.y = minY;
          if (b.vy < 0) b.vy *= -0.15;
          // Soft horizontal spread when settling on the bottom pool
          b.vx *= 0.96;
          b.vz *= 0.96;
        }

        // Top meniscus containment
        const maxY = LIQUID_Y_MAX - b.r * 0.52;
        if (b.y > maxY) {
          b.y = maxY;
          if (b.vy > 0) b.vy *= -0.15;
        }

        // Tapered glass side wall containment with smooth normal glide
        const allowedR = Math.max(0.015, bottleInnerRadius(b.y) - b.r * 0.80);
        const currR = Math.hypot(b.x, b.z);
        if (currR > allowedR) {
          const invR = 1.0 / (currR + 1e-6);
          const nx = b.x * invR;
          const nz = b.z * invR;
          b.x = nx * allowedR;
          b.z = nz * allowedR;

          // Remove outward radial velocity component so blobs glide cleanly along tapered glass
          const vRad = b.vx * nx + b.vz * nz;
          if (vRad > 0) {
            b.vx -= nx * vRad * 1.15;
            b.vz -= nz * vRad * 1.15;
          }
        }

        // --- Organic Volume-Preserving Deformation (Stretch & Squash) ---
        let targetStretch = 1.0;
        if (b.role === 1) {
          // Base pool lobes flatten nicely against the heated glass floor
          targetStretch = 0.60 + 0.14 * Math.sin(this.simTime * 0.6 + b.phase);
        } else {
          // Rising/falling blobs stretch vertically into teardrop plumes
          const speedY = Math.abs(b.vy);
          targetStretch = 1.0 + Math.min(0.42, speedY * 2.15);

          // Flatten softly when resting on the bottom or pressing against the top meniscus
          const distBot = b.y - minY;
          const distTop = maxY - b.y;
          if (distBot < 0.18) {
            const flat = 1.0 - distBot / 0.18;
            targetStretch -= flat * 0.30;
          }
          if (distTop < 0.16) {
            const flat = 1.0 - distTop / 0.16;
            targetStretch -= flat * 0.24;
          }
          // Subtle living organic breath
          targetStretch += Math.sin(this.simTime * 0.9 + b.phase * 2.0) * 0.045;
        }
        targetStretch = Math.max(0.56, Math.min(1.48, targetStretch));
        b.stretchY += (targetStretch - b.stretchY) * Math.min(1.0, dt * 3.2);

        // Lighting telemetry: how much wax shadows the incandescent bulb & where the glowing center sits
        const botWeight = Math.exp(-Math.max(0.0, b.y - LIQUID_Y_MIN) * 2.6) * Math.exp(-(b.x * b.x + b.z * b.z) * 5.0);
        occAccum += botWeight * b.r * 2.5;
        const lumW = b.r * b.r * (0.4 + 0.8 * b.temp);
        weightedY += b.y * lumW;
        totalWeight += lumW;
      }

      const targetOcc = Math.max(0.15, Math.min(0.88, occAccum * 0.45));
      this.bulbOcclusion += (targetOcc - this.bulbOcclusion) * Math.min(1.0, dt * 2.5);
      if (totalWeight > 1e-4) {
        const targetCY = weightedY / totalWeight;
        this.waxCenterY += (targetCY - this.waxCenterY) * Math.min(1.0, dt * 2.0);
      }
    }

    _packUniforms() {
      const blobs = this.blobs;
      for (let i = 0; i < BLOB_COUNT; i++) {
        const b = blobs[i];
        const o = i * 4;
        this.posRadData[o + 0] = b.x;
        this.posRadData[o + 1] = b.y;
        this.posRadData[o + 2] = b.z;
        this.posRadData[o + 3] = b.r;

        this.metaData[o + 0] = b.temp;
        this.metaData[o + 1] = b.stretchY;
        this.metaData[o + 2] = b.phase;
        this.metaData[o + 3] = b.role;
      }
    }
  }

  global.LavaLamp = global.LavaLamp || {};
  global.LavaLamp.BLOB_COUNT = BLOB_COUNT;
  global.LavaLamp.BOTTLE_Y_MIN = BOTTLE_Y_MIN;
  global.LavaLamp.BOTTLE_Y_MAX = BOTTLE_Y_MAX;
  global.LavaLamp.LIQUID_Y_MIN = LIQUID_Y_MIN;
  global.LavaLamp.LIQUID_Y_MAX = LIQUID_Y_MAX;
  global.LavaLamp.bottleOuterRadius = bottleOuterRadius;
  global.LavaLamp.bottleInnerRadius = bottleInnerRadius;
  global.LavaLamp.LavaPhysics = LavaPhysics;
})(window);
