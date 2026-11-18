(function (global) {
  'use strict';

  class LavaRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', {
        antialias: false,
        alpha: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false
      });

      if (!gl) {
        throw new Error('WebGL2 is not supported in this browser.');
      }
      this.gl = gl;

      // Detect HDR half-float FBO support with safe fallback to RGBA8
      this.extColorFloat = gl.getExtension('EXT_color_buffer_float');
      this.extColorHalfFloat = gl.getExtension('EXT_color_buffer_half_float');
      this.useHDR = Boolean(this.extColorFloat || this.extColorHalfFloat);

      this.quality = 1; // 0: Eco, 1: Balanced, 2: Ultra
      this.renderWidth = 1;
      this.renderHeight = 1;
      this.canvasWidth = 1;
      this.canvasHeight = 1;

      this.vao = gl.createVertexArray();
      this.fbos = {};

      this._initPrograms();
      this.resize();
    }

    _compileShader(type, source, label) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Shader compile error (${label}):\n${log}`);
      }
      return shader;
    }

    _createProgram(vsSrc, fsSrc, label) {
      const gl = this.gl;
      const vs = this._compileShader(gl.VERTEX_SHADER, vsSrc, `${label}:VS`);
      const fs = this._compileShader(gl.FRAGMENT_SHADER, fsSrc, `${label}:FS`);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error(`Program link error (${label}):\n${log}`);
      }
      return prog;
    }

    _initPrograms() {
      const gl = this.gl;
      const S = global.LavaLamp.Shaders;

      this.progScene = this._createProgram(S.VERTEX_SHADER, S.SCENE_FRAG_SHADER, 'Scene');
      this.progBright = this._createProgram(S.VERTEX_SHADER, S.BRIGHT_FRAG_SHADER, 'Bright');
      this.progBlur = this._createProgram(S.VERTEX_SHADER, S.BLUR_FRAG_SHADER, 'Blur');
      this.progComposite = this._createProgram(S.VERTEX_SHADER, S.COMPOSITE_FRAG_SHADER, 'Composite');

      // Cache all uniform locations
      this.uScene = {
        uResolution: gl.getUniformLocation(this.progScene, 'uResolution'),
        uTime: gl.getUniformLocation(this.progScene, 'uTime'),
        uSimTime: gl.getUniformLocation(this.progScene, 'uSimTime'),
        uCamPos: gl.getUniformLocation(this.progScene, 'uCamPos'),
        uCamTarget: gl.getUniformLocation(this.progScene, 'uCamTarget'),
        uFov: gl.getUniformLocation(this.progScene, 'uFov'),
        uBlobsPosRad: gl.getUniformLocation(this.progScene, 'uBlobsPosRad'),
        uBlobsMeta: gl.getUniformLocation(this.progScene, 'uBlobsMeta'),
        uWaxColor: gl.getUniformLocation(this.progScene, 'uWaxColor'),
        uLiquidColor: gl.getUniformLocation(this.progScene, 'uLiquidColor'),
        uGlowColor: gl.getUniformLocation(this.progScene, 'uGlowColor'),
        uHeat: gl.getUniformLocation(this.progScene, 'uHeat'),
        uBulbOcclusion: gl.getUniformLocation(this.progScene, 'uBulbOcclusion'),
        uWaxCenterY: gl.getUniformLocation(this.progScene, 'uWaxCenterY'),
        uMetalType: gl.getUniformLocation(this.progScene, 'uMetalType'),
        uRoomMood: gl.getUniformLocation(this.progScene, 'uRoomMood'),
        uQuality: gl.getUniformLocation(this.progScene, 'uQuality')
      };

      this.uBright = {
        uSceneTex: gl.getUniformLocation(this.progBright, 'uSceneTex'),
        uThreshold: gl.getUniformLocation(this.progBright, 'uThreshold'),
        uSoftKnee: gl.getUniformLocation(this.progBright, 'uSoftKnee')
      };

      this.uBlur = {
        uInputTex: gl.getUniformLocation(this.progBlur, 'uInputTex'),
        uDirection: gl.getUniformLocation(this.progBlur, 'uDirection')
      };

      this.uComposite = {
        uSceneTex: gl.getUniformLocation(this.progComposite, 'uSceneTex'),
        uBloomTight: gl.getUniformLocation(this.progComposite, 'uBloomTight'),
        uBloomWide: gl.getUniformLocation(this.progComposite, 'uBloomWide'),
        uExposure: gl.getUniformLocation(this.progComposite, 'uExposure'),
        uBloomIntensity: gl.getUniformLocation(this.progComposite, 'uBloomIntensity'),
        uTime: gl.getUniformLocation(this.progComposite, 'uTime')
      };
    }

    _createFBO(width, height, tryHDR) {
      const gl = this.gl;
      const w = Math.max(1, width | 0);
      const h = Math.max(1, height | 0);

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const internalFormat = tryHDR ? gl.RGBA16F : gl.RGBA8;
      const type = tryHDR ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, type, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);

      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
        if (tryHDR) {
          this.useHDR = false;
          return this._createFBO(w, h, false);
        }
        throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
      }

      return { fbo, tex, width: w, height: h };
    }

    _destroyFBOs() {
      const gl = this.gl;
      for (const key of Object.keys(this.fbos)) {
        const entry = this.fbos[key];
        if (entry) {
          gl.deleteFramebuffer(entry.fbo);
          gl.deleteTexture(entry.tex);
        }
      }
      this.fbos = {};
    }

    setQuality(quality) {
      this.quality = Math.max(0, Math.min(2, quality | 0));
      this.resize();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const displayW = Math.max(1, Math.floor(this.canvas.clientWidth || window.innerWidth));
      const displayH = Math.max(1, Math.floor(this.canvas.clientHeight || window.innerHeight));

      // Canvas output resolution (crisp up to 2x DPR)
      const canvasDpr = Math.min(dpr, 2.0);
      this.canvasWidth = Math.max(1, Math.floor(displayW * canvasDpr));
      this.canvasHeight = Math.max(1, Math.floor(displayH * canvasDpr));
      if (this.canvas.width !== this.canvasWidth || this.canvas.height !== this.canvasHeight) {
        this.canvas.width = this.canvasWidth;
        this.canvas.height = this.canvasHeight;
      }

      // Raymarch internal resolution scaled smartly by quality preset
      const scaleMap = [0.65, 0.94, 1.0];
      const maxRayDprMap = [1.0, 1.5, 2.0];
      const rayDpr = Math.min(dpr, maxRayDprMap[this.quality]) * scaleMap[this.quality];
      this.renderWidth = Math.max(240, Math.floor(displayW * rayDpr));
      this.renderHeight = Math.max(240, Math.floor(displayH * rayDpr));

      this._destroyFBOs();
      const hdr = this.useHDR;
      const rw = this.renderWidth;
      const rh = this.renderHeight;
      const hw = Math.max(64, rw >> 1);
      const hh = Math.max(64, rh >> 1);
      const qw = Math.max(32, rw >> 2);
      const qh = Math.max(32, rh >> 2);

      this.fbos.scene = this._createFBO(rw, rh, hdr);
      this.fbos.bright = this._createFBO(hw, hh, hdr);
      this.fbos.blurHalfA = this._createFBO(hw, hh, hdr);
      this.fbos.blurHalfB = this._createFBO(hw, hh, hdr);
      this.fbos.blurQuarterA = this._createFBO(qw, qh, hdr);
      this.fbos.blurQuarterB = this._createFBO(qw, qh, hdr);
    }

    _runBlurPass(srcTex, dstFbo, dirX, dirY) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo.fbo);
      gl.viewport(0, 0, dstFbo.width, dstFbo.height);
      gl.useProgram(this.progBlur);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(this.uBlur.uInputTex, 0);
      gl.uniform2f(this.uBlur.uDirection, dirX / dstFbo.width, dirY / dstFbo.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    render(state) {
      const gl = this.gl;
      const f = this.fbos;
      gl.bindVertexArray(this.vao);

      // -----------------------------------------------------------------------
      // Pass 1: Full Raymarched HDR Scene
      // -----------------------------------------------------------------------
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.scene.fbo);
      gl.viewport(0, 0, f.scene.width, f.scene.height);
      gl.useProgram(this.progScene);

      const u = this.uScene;
      gl.uniform2f(u.uResolution, f.scene.width, f.scene.height);
      gl.uniform1f(u.uTime, state.time);
      gl.uniform1f(u.uSimTime, state.simTime);
      gl.uniform3f(u.uCamPos, state.camPos[0], state.camPos[1], state.camPos[2]);
      gl.uniform3f(u.uCamTarget, state.camTarget[0], state.camTarget[1], state.camTarget[2]);
      gl.uniform1f(u.uFov, state.fov);
      gl.uniform4fv(u.uBlobsPosRad, state.posRadData);
      gl.uniform4fv(u.uBlobsMeta, state.metaData);
      gl.uniform3f(u.uWaxColor, state.waxColor[0], state.waxColor[1], state.waxColor[2]);
      gl.uniform3f(u.uLiquidColor, state.liquidColor[0], state.liquidColor[1], state.liquidColor[2]);
      gl.uniform3f(u.uGlowColor, state.glowColor[0], state.glowColor[1], state.glowColor[2]);
      gl.uniform1f(u.uHeat, state.heat);
      gl.uniform1f(u.uBulbOcclusion, state.bulbOcclusion);
      gl.uniform1f(u.uWaxCenterY, state.waxCenterY);
      gl.uniform1i(u.uMetalType, state.metalType);
      gl.uniform1i(u.uRoomMood, state.roomMood);
      gl.uniform1i(u.uQuality, this.quality);

      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // -----------------------------------------------------------------------
      // Pass 2: Soft-Knee Bright Pass Extraction
      // -----------------------------------------------------------------------
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.bright.fbo);
      gl.viewport(0, 0, f.bright.width, f.bright.height);
      gl.useProgram(this.progBright);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, f.scene.tex);
      gl.uniform1i(this.uBright.uSceneTex, 0);
      gl.uniform1f(this.uBright.uThreshold, this.useHDR ? 0.85 : 0.62);
      gl.uniform1f(this.uBright.uSoftKnee, 0.55);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // -----------------------------------------------------------------------
      // Pass 3: Tight Half-Res Bloom (2 H/V Gaussian iterations)
      // -----------------------------------------------------------------------
      this._runBlurPass(f.bright.tex, f.blurHalfA, 1.35, 0.0);
      this._runBlurPass(f.blurHalfA.tex, f.blurHalfB, 0.0, 1.35);
      this._runBlurPass(f.blurHalfB.tex, f.blurHalfA, 1.65, 0.0);
      this._runBlurPass(f.blurHalfA.tex, f.blurHalfB, 0.0, 1.65);

      // -----------------------------------------------------------------------
      // Pass 4: Wide Quarter-Res Atmospheric Halation (3 H/V Gaussian iterations)
      // -----------------------------------------------------------------------
      this._runBlurPass(f.blurHalfB.tex, f.blurQuarterA, 1.6, 0.0);
      this._runBlurPass(f.blurQuarterA.tex, f.blurQuarterB, 0.0, 1.6);
      this._runBlurPass(f.blurQuarterB.tex, f.blurQuarterA, 2.3, 0.0);
      this._runBlurPass(f.blurQuarterA.tex, f.blurQuarterB, 0.0, 2.3);
      this._runBlurPass(f.blurQuarterB.tex, f.blurQuarterA, 2.8, 0.0);
      this._runBlurPass(f.blurQuarterA.tex, f.blurQuarterB, 0.0, 2.8);

      // -----------------------------------------------------------------------
      // Pass 5: Final ACES Filmic Composite to Screen
      // -----------------------------------------------------------------------
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);
      gl.useProgram(this.progComposite);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, f.scene.tex);
      gl.uniform1i(this.uComposite.uSceneTex, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, f.blurHalfB.tex);
      gl.uniform1i(this.uComposite.uBloomTight, 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, f.blurQuarterB.tex);
      gl.uniform1i(this.uComposite.uBloomWide, 2);

      gl.uniform1f(this.uComposite.uExposure, 1.12);
      gl.uniform1f(this.uComposite.uBloomIntensity, 0.42 + 0.14 * Math.min(1.3, state.heat));
      gl.uniform1f(this.uComposite.uTime, state.time);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }
  }

  global.LavaLamp = global.LavaLamp || {};
  global.LavaLamp.LavaRenderer = LavaRenderer;
})(window);
