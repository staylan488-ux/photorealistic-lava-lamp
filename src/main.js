(function (global) {
  'use strict';

  const { LavaPhysics, LavaRenderer } = global.LavaLamp;

  // Convert hex "#rrggbb" -> linear RGB [r, g, b] for physically accurate shader lighting
  function hexToLinear(hex) {
    const clean = hex.replace('#', '');
    const num = parseInt(clean, 16);
    const r = ((num >> 16) & 255) / 255;
    const g = ((num >> 8) & 255) / 255;
    const b = (num & 255) / 255;
    return [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];
  }

  function lerpVec3(out, target, factor) {
    out[0] += (target[0] - out[0]) * factor;
    out[1] += (target[1] - out[1]) * factor;
    out[2] += (target[2] - out[2]) * factor;
  }

  const PRESETS = [
    {
      id: 'sunset',
      name: 'Astro Sunset',
      waxHex: '#ff2c0d',
      liquidHex: '#fff1e0',
      glowHex: '#ffcf54',
      accent: '#ff5d2e',
      swatchCss: 'radial-gradient(circle at 40% 65%, #ffd45e 0%, #ff3b14 55%, #5c0b16 100%)',
      defaultMetal: 0
    },
    {
      id: 'violet',
      name: 'Violet Magma',
      waxHex: '#ff2878',
      liquidHex: '#7042db',
      glowHex: '#ff9e6b',
      accent: '#ff4291',
      swatchCss: 'radial-gradient(circle at 40% 65%, #ff9c6e 0%, #ff2878 48%, #341678 100%)',
      defaultMetal: 0
    },
    {
      id: 'emerald',
      name: 'Emerald Biolume',
      waxHex: '#7aff24',
      liquidHex: '#1f8a74',
      glowHex: '#eeff78',
      accent: '#6be632',
      swatchCss: 'radial-gradient(circle at 40% 65%, #f0ff78 0%, #48e629 50%, #0d453b 100%)',
      defaultMetal: 3
    },
    {
      id: 'cobalt',
      name: 'Midnight Cobalt',
      waxHex: '#1ae4ff',
      liquidHex: '#1e4bc7',
      glowHex: '#bdffff',
      accent: '#2ad6ff',
      swatchCss: 'radial-gradient(circle at 40% 65%, #c7ffff 0%, #19d4ff 48%, #0e2166 100%)',
      defaultMetal: 2
    },
    {
      id: 'copper',
      name: 'Molten Amber',
      waxHex: '#ff7a0a',
      liquidHex: '#f5dcc0',
      glowHex: '#ffe98f',
      accent: '#ff9d2e',
      swatchCss: 'radial-gradient(circle at 40% 65%, #ffeb99 0%, #ff7a0a 54%, #5e2204 100%)',
      defaultMetal: 1
    },
    {
      id: 'custom',
      name: 'Custom Blend',
      waxHex: '#ff3b14',
      liquidHex: '#ffe8cc',
      glowHex: '#ffcf54',
      accent: '#e08aff',
      swatchCss: 'conic-gradient(from 0deg, #ff3b30, #ffcc00, #34c759, #00c7be, #5856d6, #ff2d55, #ff3b30)',
      defaultMetal: null
    }
  ];

  function boot() {
    const canvas = document.getElementById('glCanvas');
    const fallback = document.getElementById('fallback');

    let renderer;
    try {
      renderer = new LavaRenderer(canvas);
    } catch (err) {
      console.error(err);
      fallback.classList.remove('hidden');
      const p = fallback.querySelector('p');
      if (p) p.textContent = err.message || 'WebGL2 initialization failed.';
      return;
    }

    const physics = new LavaPhysics();

    // App State
    const state = {
      paused: false,
      autoOrbit: true,
      panelOpen: true,
      metalType: 0,
      roomMood: 0,
      presetIndex: 0,
      // Smoothly interpolated linear RGB colors
      waxColor: hexToLinear(PRESETS[0].waxHex),
      liquidColor: hexToLinear(PRESETS[0].liquidHex),
      glowColor: hexToLinear(PRESETS[0].glowHex),
      targetWax: hexToLinear(PRESETS[0].waxHex),
      targetLiquid: hexToLinear(PRESETS[0].liquidHex),
      targetGlow: hexToLinear(PRESETS[0].glowHex)
    };

    // Smooth damped spherical camera
    const defaultCam = {
      theta: 0.28,
      phi: 1.46,
      radius: 6.95,
      targetY: 1.94
    };
    const cam = {
      theta: defaultCam.theta,
      phi: defaultCam.phi,
      radius: defaultCam.radius,
      targetTheta: defaultCam.theta,
      targetPhi: defaultCam.phi,
      targetRadius: defaultCam.radius,
      targetY: defaultCam.targetY
    };

    // -------------------------------------------------------------------------
    // UI Wiring
    // -------------------------------------------------------------------------
    const presetGrid = document.getElementById('presetGrid');
    const presetNameEl = document.getElementById('presetName');
    const customColorsEl = document.getElementById('customColors');
    const inputWaxColor = document.getElementById('inputWaxColor');
    const inputLiquidColor = document.getElementById('inputLiquidColor');
    const inputGlowColor = document.getElementById('inputGlowColor');
    const brandDot = document.getElementById('brandDot');
    const brandOverlay = document.getElementById('brandOverlay');

    const sliderHeat = document.getElementById('sliderHeat');
    const heatValueEl = document.getElementById('heatValue');
    const sliderSpeed = document.getElementById('sliderSpeed');
    const speedValueEl = document.getElementById('speedValue');

    const metalSelector = document.getElementById('metalSelector');
    const moodSelector = document.getElementById('moodSelector');
    const qualitySelector = document.getElementById('qualitySelector');
    const fpsBadge = document.getElementById('fpsBadge');

    const btnShake = document.getElementById('btnShake');
    const btnPause = document.getElementById('btnPause');
    const iconPause = document.getElementById('iconPause');
    const iconPlay = document.getElementById('iconPlay');
    const btnTogglePanel = document.getElementById('btnTogglePanel');
    const controlPanel = document.getElementById('controlPanel');
    const btnColdStart = document.getElementById('btnColdStart');
    const btnAutoOrbit = document.getElementById('btnAutoOrbit');

    function setAccentCss(hex) {
      document.documentElement.style.setProperty('--accent', hex);
      document.documentElement.style.setProperty('--accent-glow', `${hex}66`);
      brandDot.style.background = hex;
      brandDot.style.boxShadow = `0 0 12px ${hex}, 0 0 22px ${hex}88`;
    }

    function setActiveMetal(idx) {
      state.metalType = idx;
      metalSelector.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.metal) === idx);
      });
    }

    function applyPreset(index, syncMetal = true) {
      state.presetIndex = index;
      const preset = PRESETS[index];
      presetNameEl.textContent = preset.name;

      presetGrid.querySelectorAll('.preset-swatch').forEach((el, i) => {
        el.classList.toggle('active', i === index);
      });

      const isCustom = preset.id === 'custom';
      customColorsEl.classList.toggle('hidden', !isCustom);

      if (isCustom) {
        state.targetWax = hexToLinear(inputWaxColor.value);
        state.targetLiquid = hexToLinear(inputLiquidColor.value);
        state.targetGlow = hexToLinear(inputGlowColor.value);
        setAccentCss(inputWaxColor.value);
      } else {
        state.targetWax = hexToLinear(preset.waxHex);
        state.targetLiquid = hexToLinear(preset.liquidHex);
        state.targetGlow = hexToLinear(preset.glowHex);
        inputWaxColor.value = preset.waxHex;
        inputLiquidColor.value = preset.liquidHex;
        inputGlowColor.value = preset.glowHex;
        setAccentCss(preset.accent);
        if (syncMetal && preset.defaultMetal !== null) {
          setActiveMetal(preset.defaultMetal);
        }
      }
    }

    // Build preset buttons
    PRESETS.forEach((preset, idx) => {
      const btn = document.createElement('button');
      btn.className = 'preset-swatch' + (idx === 0 ? ' active' : '');
      btn.title = preset.name;
      btn.setAttribute('aria-label', preset.name);
      btn.style.setProperty('--swatch-glow', preset.accent + '88');
      const inner = document.createElement('span');
      inner.className = 'preset-swatch-inner';
      inner.style.background = preset.swatchCss;
      btn.appendChild(inner);
      btn.addEventListener('click', () => applyPreset(idx, true));
      presetGrid.appendChild(btn);
    });
    setAccentCss(PRESETS[0].accent);

    // Custom color picker listeners
    function onCustomColorChange() {
      if (PRESETS[state.presetIndex].id !== 'custom') {
        applyPreset(PRESETS.length - 1, false);
      }
      state.targetWax = hexToLinear(inputWaxColor.value);
      state.targetLiquid = hexToLinear(inputLiquidColor.value);
      state.targetGlow = hexToLinear(inputGlowColor.value);
      setAccentCss(inputWaxColor.value);
    }
    inputWaxColor.addEventListener('input', onCustomColorChange);
    inputLiquidColor.addEventListener('input', onCustomColorChange);
    inputGlowColor.addEventListener('input', onCustomColorChange);

    // Heat / Dimmer
    sliderHeat.addEventListener('input', () => {
      const val = parseFloat(sliderHeat.value);
      physics.heatPower = val;
      physics.coldStartActive = false;
      heatValueEl.textContent = val <= 0.01 ? 'Off' : `${Math.round(val * 100)}%`;
    });

    // Flow speed
    sliderSpeed.addEventListener('input', () => {
      const val = parseFloat(sliderSpeed.value);
      physics.timeScale = val;
      speedValueEl.textContent = `${val.toFixed(1)}×`;
    });

    // Metal finish
    metalSelector.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      setActiveMetal(Number(btn.dataset.metal));
    });

    // Room ambience
    moodSelector.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      state.roomMood = Number(btn.dataset.mood);
      moodSelector.querySelectorAll('.seg-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
    });

    // Quality
    qualitySelector.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      const q = Number(btn.dataset.quality);
      renderer.setQuality(q);
      qualitySelector.querySelectorAll('.seg-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
    });

    // Shake
    btnShake.addEventListener('click', () => {
      physics.triggerShake(1.0);
    });

    // Pause / Resume
    function togglePause() {
      state.paused = !state.paused;
      iconPause.classList.toggle('hidden', state.paused);
      iconPlay.classList.toggle('hidden', !state.paused);
      btnPause.classList.toggle('active', state.paused);
    }
    btnPause.addEventListener('click', togglePause);

    // Toggle Drawer Panel
    function togglePanel() {
      state.panelOpen = !state.panelOpen;
      controlPanel.classList.toggle('collapsed', !state.panelOpen);
      btnTogglePanel.classList.toggle('active', state.panelOpen);
      brandOverlay.classList.toggle('dimmed', !state.panelOpen);
    }
    btnTogglePanel.addEventListener('click', togglePanel);

    // Cold Warm-Up
    btnColdStart.addEventListener('click', () => {
      physics.triggerColdStart();
      sliderHeat.value = String(physics.heatPower);
      heatValueEl.textContent = `${Math.round(physics.heatPower * 100)}%`;
      if (state.paused) togglePause();
    });

    // Auto Orbit Drift
    btnAutoOrbit.addEventListener('click', () => {
      state.autoOrbit = !state.autoOrbit;
      btnAutoOrbit.classList.toggle('active', state.autoOrbit);
    });

    // -------------------------------------------------------------------------
    // Camera Orbit, Zoom & Touch Gestures
    // -------------------------------------------------------------------------
    let isDragging = false;
    let lastX = 0;
    let lastY = 0;
    let activePointers = new Map();
    let pinchStartDist = 0;
    let pinchStartRadius = cam.targetRadius;

    function resetCamera() {
      cam.targetTheta = defaultCam.theta;
      cam.targetPhi = defaultCam.phi;
      cam.targetRadius = defaultCam.radius;
    }

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size === 1) {
        isDragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
      } else if (activePointers.size === 2) {
        isDragging = false;
        const pts = Array.from(activePointers.values());
        pinchStartDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        pinchStartRadius = cam.targetRadius;
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 1 && isDragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        cam.targetTheta -= dx * 0.0068;
        cam.targetPhi = Math.max(0.45, Math.min(1.56, cam.targetPhi - dy * 0.0055));
      } else if (activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        if (pinchStartDist > 10) {
          const ratio = pinchStartDist / Math.max(dist, 10);
          cam.targetRadius = Math.max(3.6, Math.min(11.5, pinchStartRadius * ratio));
        }
      }
    });

    function onPointerEnd(e) {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) {
        pinchStartDist = 0;
      }
      if (activePointers.size === 1) {
        const pt = Array.from(activePointers.values())[0];
        lastX = pt.x;
        lastY = pt.y;
        isDragging = true;
      } else {
        isDragging = false;
      }
    }
    canvas.addEventListener('pointerup', onPointerEnd);
    canvas.addEventListener('pointercancel', onPointerEnd);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      cam.targetRadius = Math.max(3.6, Math.min(11.5, cam.targetRadius + e.deltaY * 0.0045));
    }, { passive: false });

    canvas.addEventListener('dblclick', resetCamera);

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      const key = e.key.toLowerCase();
      if (key === ' ') {
        e.preventDefault();
        togglePause();
      } else if (key === 'h') {
        togglePanel();
      } else if (key === 's') {
        physics.triggerShake(1.0);
      } else if (key === 'r') {
        resetCamera();
      }
    });

    // Resize listener
    let resizeRaf = 0;
    window.addEventListener('resize', () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        renderer.resize();
        resizeRaf = 0;
      });
    });

    // Collapse drawer automatically on very small mobile screens so lamp is center stage
    if (window.innerWidth <= 640) {
      togglePanel();
    }

    // -------------------------------------------------------------------------
    // Main Animation Loop
    // -------------------------------------------------------------------------
    let lastTime = performance.now();
    let elapsed = 0;
    let fpsFrames = 0;
    let fpsAccum = 0;

    function frame(now) {
      requestAnimationFrame(frame);
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;
      elapsed += dt;

      // FPS badge update every ~0.5s
      fpsFrames++;
      fpsAccum += dt;
      if (fpsAccum >= 0.5) {
        const fps = Math.round(fpsFrames / fpsAccum);
        fpsBadge.textContent = `${fps} FPS`;
        fpsFrames = 0;
        fpsAccum = 0;
      }

      // Physics step
      if (!state.paused) {
        physics.step(dt);
      }

      // Smooth color transition
      const colorLerp = Math.min(1.0, dt * 6.5);
      lerpVec3(state.waxColor, state.targetWax, colorLerp);
      lerpVec3(state.liquidColor, state.targetLiquid, colorLerp);
      lerpVec3(state.glowColor, state.targetGlow, colorLerp);

      // Gentle automatic camera drift when not dragging
      if (state.autoOrbit && !isDragging && activePointers.size === 0) {
        cam.targetTheta += dt * 0.085;
      }

      // Smooth damped camera tracking
      const camSmooth = Math.min(1.0, dt * 8.5);
      cam.theta += (cam.targetTheta - cam.theta) * camSmooth;
      cam.phi += (cam.targetPhi - cam.phi) * camSmooth;
      cam.radius += (cam.targetRadius - cam.radius) * camSmooth;

      // Subtle vertical framing adjustment for narrow portrait screens
      const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
      const portraitPull = aspect < 0.75 ? (0.75 - aspect) * 2.8 : 0.0;
      const effRadius = cam.radius + portraitPull;

      const sinPhi = Math.sin(cam.phi);
      const cosPhi = Math.cos(cam.phi);
      const camPos = [
        effRadius * sinPhi * Math.sin(cam.theta),
        Math.max(0.22, cam.targetY + effRadius * cosPhi),
        effRadius * sinPhi * Math.cos(cam.theta)
      ];

      renderer.render({
        time: elapsed,
        simTime: physics.simTime,
        camPos,
        camTarget: [0.0, cam.targetY, 0.0],
        fov: 38.0,
        posRadData: physics.posRadData,
        metaData: physics.metaData,
        waxColor: state.waxColor,
        liquidColor: state.liquidColor,
        glowColor: state.glowColor,
        heat: physics.smoothedHeat,
        bulbOcclusion: physics.bulbOcclusion,
        waxCenterY: physics.waxCenterY,
        metalType: state.metalType,
        roomMood: state.roomMood
      });
    }

    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
