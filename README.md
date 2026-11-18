# ASTRO — Photorealistic WebGL2 Lava Lamp Simulation

A real-time, zero-dependency WebGL2 raymarched photorealistic lava lamp inspired by the iconic 1963 Mathmos Astro silhouette.

## Highlights

- **Rayleigh–Bénard Thermal Convection Physics**: 26 deformable 3D metaball wax parcels with thermal buoyancy, bottom-coil heating, upper radiative cooling, capillary cohesion, thermal conduction on contact, volume-preserving teardrop stretching/flattening, and interactive slosh/shake physics.
- **Volumetric Subsurface Scattering (SSS)**: Multi-step optical depth marching from every wax hit toward the bottom tungsten bulb and along the view ray — creating incandescent glowing thin necks, real-time soft translucent shadowing between blobs, Beer-Lambert chromatic depth absorption, internal paraffin marbling, and soft low-IOR submerged waxy sheen.
- **Dual-Wall Glass Optics**: True Snell refraction (air → soda-lime glass → fluid → glass → air), grazing glass-edge light piping, outer studio window Fresnel reflections, top liquid meniscus ring, submerged heating coil, and drifting micro-bubbles.
- **Anisotropic Spun Metal & Oiled Walnut Desk**: Concentric lathe-turned brushed metal finishes (Aluminum, Copper, Obsidian, Brass) with live warm lamp spill, resting on a procedural dark oiled walnut tabletop with contact AO, warm glowing halo, and real-time glossy lamp reflection.
- **HDR Multi-Pass Bloom & ACES Filmic Tone Mapping**: Half-float HDR render pipeline with dual-scale separable Gaussian bloom, subtle optical lens halation, and triangular-PDF micro-dither.

## Controls

- **Drag / Touch**: Orbit 3D camera around the lamp
- **Scroll / Pinch**: Zoom in and out
- **Double-Click / `R`**: Reset camera framing
- **`S`**: Gentle shake (sloshes & swirls wax)
- **`Space`**: Pause / Resume physics
- **`H`**: Hide / Show floating control drawer
