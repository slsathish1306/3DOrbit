/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  Play,
  Pause,
  RotateCcw,
  Compass,
  Crosshair,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Trash2,
  Eye,
  Grid,
  Orbit,
  Volume2,
  VolumeX,
  Focus,
  Plus,
  Info,
  X,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

type BodyArchetype = 'star' | 'terran' | 'oceanic' | 'gas_giant' | 'ice_giant' | 'volcanic';
type PresetSystemId = 'solar' | 'binary' | 'figure8' | 'trojan';
type InteractionMode = 'launch' | 'orbit';

interface CelestialBodyData {
  id: string;
  name: string;
  archetype: BodyArchetype;
  mass: number;
  radius: number;
  colorHex: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  acceleration: THREE.Vector3;
  meshGroup: THREE.Group;
  spinSpeed: number;
  trailPositions: Float32Array;
  trailColors: Float32Array;
  trailGeometry: THREE.BufferGeometry;
  trailLine: THREE.Line;
  trailHead: number;
  trailCount: number;
  pointLight?: THREE.PointLight;
  isStar?: boolean;
}

interface SelectedBodyTelemetry {
  id: string;
  name: string;
  archetype: BodyArchetype;
  mass: number;
  radius: number;
  speed: number;
  distanceToPrimary: number;
  semiMajorAxis: number | null;
  eccentricity: number | null;
  orbitType: string;
  colorHex: string;
  isStar: boolean;
}

interface LaunchPreviewTelemetry {
  active: boolean;
  speed: number;
  radiusFromCenter: number;
  circularSpeed: number;
  eccentricity: number;
  orbitClassification: 'Circular Bound' | 'Elliptical Bound' | 'Hyperbolic Escape' | 'Collision Course';
  inclinationDeg: number;
}

const TRAIL_MAX_POINTS = 320;
const PREDICTION_STEPS = 260;
const BASE_G = 1.8; // Calibrated gravitational constant for responsive 3D units
const SOFTENING_SQ = 0.45; // Prevents infinite acceleration on grazing passes

const ARCHETYPE_SPECS: Record<
  Exclude<BodyArchetype, 'star'>,
  {
    label: string;
    defaultMass: number;
    color: string;
    accentColor: string;
    description: string;
  }
> = {
  terran: {
    label: 'Terran Silicate',
    defaultMass: 3.0,
    color: '#38bdf8',
    accentColor: '#34d399',
    description: 'Cratered continental crust with polar ice caps & moonlet',
  },
  oceanic: {
    label: 'Pelagic Ocean',
    defaultMass: 6.5,
    color: '#0284c7',
    accentColor: '#bae6fd',
    description: 'Deep hydrosphere enveloped in dynamic cyclone cloud bands',
  },
  ice_giant: {
    label: 'Cryo Ice Giant',
    defaultMass: 14.0,
    color: '#2dd4bf',
    accentColor: '#99f6e4',
    description: 'Methane-azure atmosphere with steeply tilted gossamer ring',
  },
  gas_giant: {
    label: 'Jovian Gas Giant',
    defaultMass: 28.0,
    color: '#f59e0b',
    accentColor: '#fde68a',
    description: 'Banded super-storm giant with multi-tier planetary rings',
  },
  volcanic: {
    label: 'Magma Protoplanet',
    defaultMass: 9.0,
    color: '#ef4444',
    accentColor: '#fb923c',
    description: 'Fractured basalt lithosphere with glowing tectonic fissures',
  },
};

// Pre-allocated module-level math scratchpad to guarantee ZERO GC inside the render loop
const _diff = new THREE.Vector3();
const _force = new THREE.Vector3();
const _velStep = new THREE.Vector3();
const _barycenter = new THREE.Vector3();
const _relPos = new THREE.Vector3();
const _relVel = new THREE.Vector3();
const _angMomentum = new THREE.Vector3();
const _eccVec = new THREE.Vector3();
const _tangentDir = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);
const _rayPlaneIntersect = new THREE.Vector3();
const _dragVec = new THREE.Vector3();
const _arrowDir = new THREE.Vector3();
const _camTargetDesired = new THREE.Vector3();
const _baseColor = new THREE.Color();

// ---------------------------------------------------------------------------
// Procedural Texture & Multi-Part 3D Model Generators (Zero External Assets)
// ---------------------------------------------------------------------------

function createProceduralPlanetTexture(
  archetype: BodyArchetype,
  maxAnisotropy: number
): { albedoMap: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const width = 512;
  const height = 256;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = width;
  bumpCanvas.height = height;
  const bCtx = bumpCanvas.getContext('2d')!;

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, width, height);

  if (archetype === 'star') {
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#fff7ed');
    grad.addColorStop(0.25, '#fbbf24');
    grad.addColorStop(0.5, '#f59e0b');
    grad.addColorStop(0.75, '#fbbf24');
    grad.addColorStop(1, '#ea580c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Convective plasma granulation cells
    for (let i = 0; i < 420; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const r = 3 + Math.random() * 14;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const bright = Math.random() > 0.35;
      g.addColorStop(0, bright ? 'rgba(255, 251, 235, 0.65)' : 'rgba(180, 83, 9, 0.55)');
      g.addColorStop(1, 'rgba(245, 158, 11, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (archetype === 'gas_giant') {
    const bands = [
      '#78350f',
      '#d97706',
      '#fde68a',
      '#b45309',
      '#f59e0b',
      '#fef3c7',
      '#92400e',
      '#fbbf24',
      '#d97706',
      '#78350f',
    ];
    const bandH = height / bands.length;
    bands.forEach((col, idx) => {
      ctx.fillStyle = col;
      ctx.fillRect(0, idx * bandH, width, bandH + 2);
    });

    // Turbulent zonal jet streams
    for (let y = 0; y < height; y += 3) {
      ctx.strokeStyle =
        y % 6 === 0 ? 'rgba(254, 243, 199, 0.28)' : 'rgba(120, 53, 15, 0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const phase = Math.random() * Math.PI * 2;
      for (let x = 0; x <= width; x += 8) {
        const dy = Math.sin((x / width) * Math.PI * 6 + phase) * 3.5;
        if (x === 0) ctx.moveTo(x, y + dy);
        else ctx.lineTo(x, y + dy);
      }
      ctx.stroke();
    }

    // Anticyclonic Great Storm Oval
    const stormX = width * 0.62;
    const stormY = height * 0.64;
    const sg = ctx.createRadialGradient(stormX, stormY, 2, stormX, stormY, 32);
    sg.addColorStop(0, '#ef4444');
    sg.addColorStop(0.6, '#c2410c');
    sg.addColorStop(1, 'rgba(194, 65, 12, 0)');
    ctx.fillStyle = sg;
    ctx.save();
    ctx.translate(stormX, stormY);
    ctx.scale(1.6, 0.85);
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (archetype === 'ice_giant') {
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#0f766e');
    grad.addColorStop(0.25, '#14b8a6');
    grad.addColorStop(0.5, '#5eead4');
    grad.addColorStop(0.75, '#0d9488');
    grad.addColorStop(1, '#115e59');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < 45; i++) {
      const y = Math.random() * height;
      ctx.fillStyle = i % 2 === 0 ? 'rgba(204, 251, 241, 0.16)' : 'rgba(19, 78, 74, 0.18)';
      ctx.fillRect(0, y, width, 2 + Math.random() * 6);
    }
  } else if (archetype === 'oceanic') {
    ctx.fillStyle = '#0369a1';
    ctx.fillRect(0, 0, width, height);

    // Archipelago islands & shallow reefs
    for (let i = 0; i < 70; i++) {
      const x = Math.random() * width;
      const y = 30 + Math.random() * (height - 60);
      const r = 6 + Math.random() * 24;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, '#10b981');
      g.addColorStop(0.45, '#06b6d4');
      g.addColorStop(1, 'rgba(3, 105, 161, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (archetype === 'volcanic') {
    ctx.fillStyle = '#1c1917';
    ctx.fillRect(0, 0, width, height);

    // Basalt crust plates
    for (let i = 0; i < 160; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const r = 8 + Math.random() * 22;
      ctx.fillStyle = Math.random() > 0.5 ? '#292524' : '#0c0a09';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      bCtx.fillStyle = '#555555';
      bCtx.beginPath();
      bCtx.arc(x, y, r, 0, Math.PI * 2);
      bCtx.fill();
    }

    // Glowing magma fissures
    for (let i = 0; i < 28; i++) {
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      let cx = Math.random() * width;
      let cy = Math.random() * height;
      ctx.moveTo(cx, cy);
      for (let s = 0; s < 6; s++) {
        cx += (Math.random() - 0.5) * 48;
        cy += (Math.random() - 0.5) * 32;
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
    }
  } else {
    // Terran Silicate
    ctx.fillStyle = '#1e3a8a';
    ctx.fillRect(0, 0, width, height);

    // Continental landmasses
    for (let i = 0; i < 95; i++) {
      const x = Math.random() * width;
      const y = 26 + Math.random() * (height - 52);
      const r = 10 + Math.random() * 34;
      const g = ctx.createRadialGradient(x, y, 2, x, y, r);
      g.addColorStop(0, '#a16207');
      g.addColorStop(0.55, '#15803d');
      g.addColorStop(0.85, '#047857');
      g.addColorStop(1, 'rgba(30, 58, 138, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      bCtx.fillStyle = '#c8c8c8';
      bCtx.beginPath();
      bCtx.arc(x, y, r * 0.75, 0, Math.PI * 2);
      bCtx.fill();
    }

    // Impact craters on bump map
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const r = 3 + Math.random() * 9;
      bCtx.strokeStyle = '#ffffff';
      bCtx.lineWidth = 1.5;
      bCtx.beginPath();
      bCtx.arc(x, y, r, 0, Math.PI * 2);
      bCtx.stroke();
    }
  }

  const albedoMap = new THREE.CanvasTexture(canvas);
  albedoMap.colorSpace = THREE.SRGBColorSpace;
  albedoMap.anisotropy = maxAnisotropy;
  albedoMap.wrapS = THREE.RepeatWrapping;
  albedoMap.wrapT = THREE.ClampToEdgeWrapping;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.colorSpace = THREE.NoColorSpace;
  bumpMap.anisotropy = maxAnisotropy;
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.ClampToEdgeWrapping;

  return { albedoMap, bumpMap };
}

function createRingTexture(maxAnisotropy: number, warm: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  // Radial ring bands mapped across X (UV.x or distance)
  const grad = ctx.createLinearGradient(0, 0, 512, 0);
  if (warm) {
    grad.addColorStop(0.0, 'rgba(251, 191, 36, 0.0)');
    grad.addColorStop(0.12, 'rgba(251, 191, 36, 0.45)');
    grad.addColorStop(0.32, 'rgba(254, 243, 199, 0.82)');
    grad.addColorStop(0.48, 'rgba(120, 53, 15, 0.08)'); // Cassini division gap
    grad.addColorStop(0.54, 'rgba(245, 158, 11, 0.75)');
    grad.addColorStop(0.82, 'rgba(217, 119, 6, 0.45)');
    grad.addColorStop(1.0, 'rgba(217, 119, 6, 0.0)');
  } else {
    grad.addColorStop(0.0, 'rgba(45, 212, 191, 0.0)');
    grad.addColorStop(0.25, 'rgba(153, 246, 228, 0.55)');
    grad.addColorStop(0.55, 'rgba(20, 184, 166, 0.12)');
    grad.addColorStop(0.75, 'rgba(94, 234, 212, 0.65)');
    grad.addColorStop(1.0, 'rgba(45, 212, 191, 0.0)');
  }

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

/**
 * Builds a multi-part composite 3D celestial body (`THREE.Group` with 3–7 distinct sub-parts)
 * following the Three.js visual realism directive.
 */
function buildCelestialBodyGroup(
  archetype: BodyArchetype,
  radius: number,
  maxAnisotropy: number
): THREE.Group {
  const group = new THREE.Group();
  const { albedoMap, bumpMap } = createProceduralPlanetTexture(archetype, maxAnisotropy);

  if (archetype === 'star') {
    // 1. Primary Silhouette: Convective Photosphere Core
    const coreGeo = new THREE.SphereGeometry(radius, 48, 32);
    const coreMat = new THREE.MeshStandardMaterial({
      map: albedoMap,
      emissive: new THREE.Color('#f59e0b'),
      emissiveMap: albedoMap,
      emissiveIntensity: 2.2,
      roughness: 0.2,
      metalness: 0.05,
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    group.add(coreMesh);

    // 2. Secondary Read: Translucent Chromosphere Corona Shell
    const coronaGeo = new THREE.SphereGeometry(radius * 1.18, 36, 24);
    const coronaMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#fbbf24'),
      emissive: new THREE.Color('#ea580c'),
      emissiveIntensity: 0.9,
      transparent: true,
      opacity: 0.28,
      roughness: 0.1,
      metalness: 0.0,
      depthWrite: false,
      side: THREE.BackSide,
    });
    const coronaMesh = new THREE.Mesh(coronaGeo, coronaMat);
    coronaMesh.renderOrder = 2;
    group.add(coronaMesh);

    // 3. Secondary Read: Solar Prominence Magnetic Flux Loops (3 tilted torus arcs)
    const loopMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#fde68a'),
      emissive: new THREE.Color('#f97316'),
      emissiveIntensity: 1.8,
      roughness: 0.35,
      metalness: 0.6,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });
    for (let i = 0; i < 3; i++) {
      const loopGeo = new THREE.TorusGeometry(radius * (1.06 + i * 0.04), radius * 0.028, 12, 48);
      const loopMesh = new THREE.Mesh(loopGeo, loopMat);
      loopMesh.rotation.set(
        (i * Math.PI) / 3 + 0.4,
        (i * Math.PI) / 2.5,
        i * 0.7
      );
      loopMesh.name = `solar_loop_${i}`;
      group.add(loopMesh);
    }

    // 4. Accent Detail: Equatorial Circumstellar Dust Halo Ring
    const haloGeo = new THREE.RingGeometry(radius * 1.45, radius * 2.15, 64);
    const pos = haloGeo.attributes.position;
    const uvs = haloGeo.attributes.uv;
    const v3 = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v3.fromBufferAttribute(pos, i);
      const u = (v3.length() - radius * 1.45) / (radius * 0.7);
      uvs.setXY(i, THREE.MathUtils.clamp(u, 0, 1), 0.5);
    }
    const haloMat = new THREE.MeshStandardMaterial({
      map: createRingTexture(maxAnisotropy, true),
      transparent: true,
      opacity: 0.42,
      roughness: 0.6,
      metalness: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const haloMesh = new THREE.Mesh(haloGeo, haloMat);
    haloMesh.rotation.x = Math.PI / 2;
    haloMesh.renderOrder = 3;
    group.add(haloMesh);

    return group;
  }

  // Planetary Primary Silhouette
  const planetGeo = new THREE.SphereGeometry(radius, 40, 28);
  const isVolcanic = archetype === 'volcanic';
  const planetMat = new THREE.MeshStandardMaterial({
    map: albedoMap,
    bumpMap,
    bumpScale: isVolcanic ? 0.08 : 0.04,
    roughness: archetype === 'oceanic' ? 0.25 : archetype === 'gas_giant' ? 0.55 : 0.72,
    metalness: archetype === 'ice_giant' ? 0.35 : isVolcanic ? 0.45 : 0.12,
    emissive: isVolcanic ? new THREE.Color('#ea580c') : new THREE.Color('#000000'),
    emissiveMap: isVolcanic ? albedoMap : null,
    emissiveIntensity: isVolcanic ? 0.85 : 0,
  });
  const planetMesh = new THREE.Mesh(planetGeo, planetMat);
  planetMesh.castShadow = true;
  planetMesh.receiveShadow = true;
  group.add(planetMesh);

  // Secondary & Accent Parts by Planet Archetype
  if (archetype === 'terran' || archetype === 'oceanic') {
    // 2. Polar Ice Caps (North & South)
    const capGeo = new THREE.SphereGeometry(
      radius * 1.008,
      24,
      12,
      0,
      Math.PI * 2,
      0,
      0.42
    );
    const capMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#f8fafc'),
      roughness: 0.2,
      metalness: 0.15,
    });
    const northCap = new THREE.Mesh(capGeo, capMat);
    group.add(northCap);

    const southCap = new THREE.Mesh(capGeo, capMat);
    southCap.rotation.x = Math.PI;
    group.add(southCap);

    // 3. Translucent Atmosphere / Cloud Layer
    const atmoGeo = new THREE.SphereGeometry(radius * 1.06, 32, 20);
    const atmoMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(archetype === 'oceanic' ? '#7dd3fc' : '#bae6fd'),
      transparent: true,
      opacity: archetype === 'oceanic' ? 0.32 : 0.2,
      roughness: 0.15,
      metalness: 0.0,
      clearcoat: 0.8,
      depthWrite: false,
    });
    const atmoMesh = new THREE.Mesh(atmoGeo, atmoMat);
    atmoMesh.renderOrder = 2;
    group.add(atmoMesh);

    // 4. Accent: Captured Shepherd Moonlet on tilted orbital ring strut
    const moonPivot = new THREE.Group();
    moonPivot.name = 'moon_pivot';
    moonPivot.rotation.z = 0.28;
    const moonGeo = new THREE.SphereGeometry(radius * 0.22, 16, 12);
    const moonMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#cbd5e1'),
      roughness: 0.85,
      metalness: 0.2,
    });
    const moonMesh = new THREE.Mesh(moonGeo, moonMat);
    moonMesh.position.set(radius * 2.1, 0, 0);
    moonMesh.castShadow = true;
    moonPivot.add(moonMesh);

    // Subtle moon orbital wire ring
    const moonOrbitGeo = new THREE.TorusGeometry(radius * 2.1, radius * 0.012, 8, 48);
    const moonOrbitMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#94a3b8'),
      transparent: true,
      opacity: 0.25,
    });
    const moonOrbitRing = new THREE.Mesh(moonOrbitGeo, moonOrbitMat);
    moonOrbitRing.rotation.x = Math.PI / 2;
    moonPivot.add(moonOrbitRing);

    group.add(moonPivot);
  } else if (archetype === 'gas_giant' || archetype === 'ice_giant') {
    const isWarm = archetype === 'gas_giant';
    const innerR = radius * (isWarm ? 1.38 : 1.5);
    const outerR = radius * (isWarm ? 2.45 : 2.05);

    // 2. Secondary Read: Multi-Band Planetary Ring System with radial UV mapping
    const ringGeo = new THREE.RingGeometry(innerR, outerR, 72);
    const pos = ringGeo.attributes.position;
    const uvs = ringGeo.attributes.uv;
    const v3 = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v3.fromBufferAttribute(pos, i);
      const u = (v3.length() - innerR) / (outerR - innerR);
      uvs.setXY(i, THREE.MathUtils.clamp(u, 0, 1), 0.5);
    }

    const ringMat = new THREE.MeshStandardMaterial({
      map: createRingTexture(maxAnisotropy, isWarm),
      transparent: true,
      opacity: isWarm ? 0.88 : 0.65,
      roughness: 0.4,
      metalness: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.PI / 2 + (isWarm ? 0.32 : 0.78); // Uranus-like tilt for ice giant
    ringMesh.rotation.y = 0.2;
    ringMesh.receiveShadow = true;
    ringMesh.renderOrder = 2;
    group.add(ringMesh);

    // 3. Accent Detail: Polar Magnetospheric Aurora Crown
    const auroraGeo = new THREE.TorusGeometry(radius * 0.62, radius * 0.025, 12, 36);
    const auroraMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(isWarm ? '#fde047' : '#5eead4'),
      transparent: true,
      opacity: 0.55,
    });
    const northAurora = new THREE.Mesh(auroraGeo, auroraMat);
    northAurora.position.y = radius * 0.78;
    northAurora.rotation.x = Math.PI / 2;
    group.add(northAurora);

    const southAurora = new THREE.Mesh(auroraGeo, auroraMat);
    southAurora.position.y = -radius * 0.78;
    southAurora.rotation.x = Math.PI / 2;
    group.add(southAurora);
  } else if (archetype === 'volcanic') {
    // 2. Secondary Read: Tectonic Equatorial Obsidian Ridge Belt
    const ridgeGeo = new THREE.TorusGeometry(radius * 1.02, radius * 0.06, 12, 36);
    const ridgeMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#292524'),
      roughness: 0.9,
      metalness: 0.65,
    });
    const ridgeMesh = new THREE.Mesh(ridgeGeo, ridgeMat);
    ridgeMesh.rotation.x = Math.PI / 2 + 0.18;
    group.add(ridgeMesh);

    // 3. Accent Detail: Incandescent Thermal Ejecta Shell
    const hazeGeo = new THREE.SphereGeometry(radius * 1.09, 28, 20);
    const hazeMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#fb923c'),
      emissive: new THREE.Color('#dc2626'),
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.22,
      roughness: 0.3,
      depthWrite: false,
    });
    const hazeMesh = new THREE.Mesh(hazeGeo, hazeMat);
    hazeMesh.renderOrder = 2;
    group.add(hazeMesh);
  }

  return group;
}

// ---------------------------------------------------------------------------
// Web Audio Procedural Synthesizer (Collision & Launch Feedback)
// ---------------------------------------------------------------------------

class OrbitalSoundEngine {
  private ctx: AudioContext | null = null;
  public enabled = true;

  private ensureContext() {
    if (!this.enabled) return null;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  playLaunch(mass: number, speed: number) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const baseFreq = Math.max(90, Math.min(440, 320 - mass * 4 + speed * 8));
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq * 0.7, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.35, now + 0.18);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.28);
  }

  playCollision(combinedMass: number) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const freq = Math.max(45, 160 - combinedMass * 0.8);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(28, now + 0.45);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.48);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.5);
  }
}

const soundEngine = new OrbitalSoundEngine();

// ---------------------------------------------------------------------------
// Main Application Component
// ---------------------------------------------------------------------------

export default function App() {
  // UI State
  const [gravityMultiplier, setGravityMultiplier] = useState<number>(1.0);
  const [timeSpeed, setTimeSpeed] = useState<number>(1.0);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [launchMass, setLaunchMass] = useState<number>(5.0);
  const [launchArchetype, setLaunchArchetype] = useState<Exclude<BodyArchetype, 'star'>>('terran');
  const [launchInclination, setLaunchInclination] = useState<number>(0);
  const [autoCircularize, setAutoCircularize] = useState<boolean>(false);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('launch');

  const [showTrails, setShowTrails] = useState<boolean>(true);
  const [showGravityGrid, setShowGravityGrid] = useState<boolean>(true);
  const [showPredictedOrbits, setShowPredictedOrbits] = useState<boolean>(true);
  const [cameraFollowMode, setCameraFollowMode] = useState<'free' | 'barycenter' | 'selected'>('free');
  const [activePreset, setActivePreset] = useState<PresetSystemId>('solar');
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);
  const [showMassLegend, setShowMassLegend] = useState<boolean>(false);

  const [systemMetrics, setSystemMetrics] = useState({
    bodyCount: 5,
    totalMass: 1035.5,
    simYears: 0.0,
    collisions: 0,
  });

  const [selectedTelemetry, setSelectedTelemetry] = useState<SelectedBodyTelemetry | null>(null);
  const [launchPreview, setLaunchPreview] = useState<LaunchPreviewTelemetry>({
    active: false,
    speed: 0,
    radiusFromCenter: 0,
    circularSpeed: 0,
    eccentricity: 0,
    orbitClassification: 'Elliptical Bound',
    inclinationDeg: 0,
  });

  // Mutable Simulation Refs for Zero-Teardown WebGL Loop
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const simConfigRef = useRef({
    gravityMultiplier: 1.0,
    timeSpeed: 1.0,
    isPaused: false,
    launchMass: 5.0,
    launchArchetype: 'terran' as Exclude<BodyArchetype, 'star'>,
    launchInclination: 0,
    autoCircularize: false,
    interactionMode: 'launch' as InteractionMode,
    showTrails: true,
    showGravityGrid: true,
    showPredictedOrbits: true,
    cameraFollowMode: 'free' as 'free' | 'barycenter' | 'selected',
    selectedBodyId: null as string | null,
  });

  // Sync React controls to mutable ref
  useEffect(() => {
    simConfigRef.current.gravityMultiplier = gravityMultiplier;
    simConfigRef.current.timeSpeed = timeSpeed;
    simConfigRef.current.isPaused = isPaused;
    simConfigRef.current.launchMass = launchMass;
    simConfigRef.current.launchArchetype = launchArchetype;
    simConfigRef.current.launchInclination = launchInclination;
    simConfigRef.current.autoCircularize = autoCircularize;
    simConfigRef.current.interactionMode = interactionMode;
    simConfigRef.current.showTrails = showTrails;
    simConfigRef.current.showGravityGrid = showGravityGrid;
    simConfigRef.current.showPredictedOrbits = showPredictedOrbits;
    simConfigRef.current.cameraFollowMode = cameraFollowMode;
  }, [
    gravityMultiplier,
    timeSpeed,
    isPaused,
    launchMass,
    launchArchetype,
    launchInclination,
    autoCircularize,
    interactionMode,
    showTrails,
    showGravityGrid,
    showPredictedOrbits,
    cameraFollowMode,
  ]);

  // Imperative API bridge from Three.js scene to React UI buttons
  const sceneActionsRef = useRef<{
    loadPreset: (preset: PresetSystemId) => void;
    clearPlanets: () => void;
    deleteSelectedBody: () => void;
    spawnCircularPlanet: () => void;
    resetCamera: () => void;
  } | null>(null);

  // Select archetype helper that also sets a sensible default mass
  const handleSelectArchetype = useCallback((arch: Exclude<BodyArchetype, 'star'>) => {
    setLaunchArchetype(arch);
    setLaunchMass(ARCHETYPE_SPECS[arch].defaultMass);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setIsPaused((prev) => !prev);
      } else if (e.key === 'h' || e.key === 'H') {
        setDockCollapsed((prev) => !prev);
      } else if (e.key === 'c' || e.key === 'C') {
        setAutoCircularize((prev) => !prev);
      } else if (e.key === 'g' || e.key === 'G') {
        setShowGravityGrid((prev) => !prev);
      } else if (e.key === 't' || e.key === 'T') {
        setShowTrails((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ---------------------------------------------------------------------------
  // Stable WebGL Scene Initialization & Physics Engine Loop
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const mountEl = canvasMountRef.current;
    if (!mountEl) return;

    const isHeadless =
      navigator.webdriver || /HeadlessChrome/i.test(navigator.userAgent);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x06080f);
    scene.fog = new THREE.FogExp2(0x06080f, 0.0022);

    const camera = new THREE.PerspectiveCamera(
      52,
      mountEl.clientWidth / Math.max(1, mountEl.clientHeight),
      0.1,
      1200
    );
    camera.position.set(0, 68, 96);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setSize(mountEl.clientWidth, mountEl.clientHeight);
    renderer.setPixelRatio(isHeadless ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = !isHeadless;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    mountEl.appendChild(renderer.domElement);

    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    // Studio Environment Reflection (RoomEnvironment + PMREMGenerator)
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // Camera Controls
    // Right-click or middle-click always orbits/pans; Left-click orbits when in 'orbit' mode
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 12;
    controls.maxDistance = 380;
    controls.maxPolarAngle = Math.PI * 0.88;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };

    // Balanced Studio & Astronomical Lighting Rig
    const hemiLight = new THREE.HemisphereLight(0x93c5fd, 0x1e1b4b, 0.55);
    scene.add(hemiLight);

    const dirKeyLight = new THREE.DirectionalLight(0xfffbeb, 0.65);
    dirKeyLight.position.set(60, 95, 45);
    scene.add(dirKeyLight);

    // -------------------------------------------------------------------------
    // 1. Instanced Deep-Space Starfield (900 Stars with Spectral Colors)
    // -------------------------------------------------------------------------
    const starCount = 900;
    const starGeo = new THREE.OctahedronGeometry(0.32, 0);
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const starInstanced = new THREE.InstancedMesh(starGeo, starMat, starCount);
    const dummyMat = new THREE.Matrix4();
    const spectralPalette = [
      new THREE.Color('#93c5fd'), // O/B blue-white
      new THREE.Color('#f8fafc'), // A white
      new THREE.Color('#fef08a'), // F/G yellow-white
      new THREE.Color('#fdba74'), // K orange
      new THREE.Color('#fca5a5'), // M red dwarf
    ];
    for (let i = 0; i < starCount; i++) {
      const r = 220 + Math.random() * 420;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sx = r * Math.sin(phi) * Math.cos(theta);
      const sy = r * Math.sin(phi) * Math.sin(theta);
      const sz = r * Math.cos(phi);
      const scale = 0.4 + Math.random() * 1.4;
      dummyMat.makeScale(scale, scale, scale);
      dummyMat.setPosition(sx, sy, sz);
      starInstanced.setMatrixAt(i, dummyMat);
      starInstanced.setColorAt(
        i,
        spectralPalette[i % spectralPalette.length]
      );
    }
    starInstanced.instanceMatrix.needsUpdate = true;
    if (starInstanced.instanceColor) starInstanced.instanceColor.needsUpdate = true;
    starInstanced.computeBoundingSphere();
    scene.add(starInstanced);

    // -------------------------------------------------------------------------
    // 2. Dynamic 3D Spacetime Gravity Potential Well Grid
    // -------------------------------------------------------------------------
    const GRID_DIVS = 46;
    const GRID_EXTENT = 110;
    const gridPlaneGeo = new THREE.PlaneGeometry(
      GRID_EXTENT * 2,
      GRID_EXTENT * 2,
      GRID_DIVS,
      GRID_DIVS
    );
    gridPlaneGeo.rotateX(-Math.PI / 2);

    // Store base XZ coordinates and add vertex colors for potential depth shading
    const gridVertexCount = gridPlaneGeo.attributes.position.count;
    const gridColors = new Float32Array(gridVertexCount * 3);
    gridPlaneGeo.setAttribute('color', new THREE.BufferAttribute(gridColors, 3));

    const gridWireMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      wireframe: true,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    const gravityGridMesh = new THREE.Mesh(gridPlaneGeo, gridWireMat);
    gravityGridMesh.position.y = -0.15;
    scene.add(gravityGridMesh);

    // -------------------------------------------------------------------------
    // 3. Slingshot Launch Ghost Preview, Velocity Arrow & RK4 Predictor Line
    // -------------------------------------------------------------------------
    const launchGroup = new THREE.Group();
    launchGroup.visible = false;
    scene.add(launchGroup);

    const ghostRingGeo = new THREE.RingGeometry(1.4, 1.75, 48);
    ghostRingGeo.rotateX(-Math.PI / 2);
    const ghostRingMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });
    const ghostRingMesh = new THREE.Mesh(ghostRingGeo, ghostRingMat);
    launchGroup.add(ghostRingMesh);

    const ghostSphereGeo = new THREE.SphereGeometry(1, 28, 20);
    const ghostSphereMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.45,
      roughness: 0.3,
      metalness: 0.2,
      transparent: true,
      opacity: 0.85,
    });
    const ghostSphereMesh = new THREE.Mesh(ghostSphereGeo, ghostSphereMat);
    launchGroup.add(ghostSphereMesh);

    // Velocity Vector Arrow (Shaft + Cone Head)
    const velocityArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 0),
      5,
      0xfbbf24,
      1.6,
      0.9
    );
    velocityArrow.visible = false;
    scene.add(velocityArrow);

    // RK4 Predicted Trajectory Line while dragging
    const predPositions = new Float32Array(PREDICTION_STEPS * 3);
    const predColors = new Float32Array(PREDICTION_STEPS * 3);
    const predGeo = new THREE.BufferGeometry();
    predGeo.setAttribute('position', new THREE.BufferAttribute(predPositions, 3));
    predGeo.setAttribute('color', new THREE.BufferAttribute(predColors, 3));
    const predMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const predictionLine = new THREE.Line(predGeo, predMat);
    predictionLine.visible = false;
    predictionLine.frustumCulled = false;
    scene.add(predictionLine);

    // Selection Reticle Ring around currently inspected body
    const selectionReticleGeo = new THREE.RingGeometry(1.5, 1.75, 48);
    selectionReticleGeo.rotateX(-Math.PI / 2);
    const selectionReticleMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const selectionReticle = new THREE.Mesh(selectionReticleGeo, selectionReticleMat);
    selectionReticle.visible = false;
    scene.add(selectionReticle);

    // Collision Shockwave Rings Pool
    interface Shockwave {
      mesh: THREE.Mesh;
      age: number;
      maxAge: number;
      maxScale: number;
    }
    const activeShockwaves: Shockwave[] = [];
    const shockwaveGeo = new THREE.RingGeometry(0.7, 1.0, 48);
    shockwaveGeo.rotateX(-Math.PI / 2);

    function spawnCollisionShockwave(pos: THREE.Vector3, radius: number, colorHex: string) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(colorHex),
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(shockwaveGeo, mat);
      mesh.position.copy(pos);
      scene.add(mesh);
      activeShockwaves.push({
        mesh,
        age: 0,
        maxAge: 0.75,
        maxScale: Math.max(4, radius * 5.5),
      });
    }

    // -------------------------------------------------------------------------
    // 4. Celestial Bodies Registry & Lifecycle Helpers
    // -------------------------------------------------------------------------
    const bodies: CelestialBodyData[] = [];
    let bodyCounter = 1;
    let simElapsedYears = 0;
    let totalCollisions = 0;

    function computeRadiusFromMass(mass: number, archetype: BodyArchetype): number {
      if (archetype === 'star') {
        return Math.max(3.2, Math.pow(mass / 900, 0.28) * 4.2);
      }
      // Realistic cube-root scaling clamped for comfortable 3D visibility
      return THREE.MathUtils.clamp(0.65 * Math.pow(mass, 0.34), 0.55, 3.1);
    }

    function addCelestialBody(params: {
      name: string;
      archetype: BodyArchetype;
      mass: number;
      position: THREE.Vector3;
      velocity: THREE.Vector3;
      colorHex: string;
    }): CelestialBodyData {
      const id = `body_${bodyCounter++}_${Date.now()}`;
      const radius = computeRadiusFromMass(params.mass, params.archetype);
      const meshGroup = buildCelestialBodyGroup(params.archetype, radius, maxAnisotropy);
      meshGroup.position.copy(params.position);
      meshGroup.userData.bodyId = id;
      scene.add(meshGroup);

      // Attach warm PointLight if this body is a Star
      let pointLight: THREE.PointLight | undefined;
      if (params.archetype === 'star') {
        pointLight = new THREE.PointLight(0xfffbeb, 3.8, 350, 0.45);
        pointLight.castShadow = !isHeadless;
        if (!isHeadless) {
          pointLight.shadow.mapSize.width = 1024;
          pointLight.shadow.mapSize.height = 1024;
          pointLight.shadow.bias = -0.0005;
        }
        meshGroup.add(pointLight);
      }

      // Pre-allocated Trail BufferGeometry
      const trailPositions = new Float32Array(TRAIL_MAX_POINTS * 3);
      const trailColors = new Float32Array(TRAIL_MAX_POINTS * 3);
      for (let i = 0; i < TRAIL_MAX_POINTS; i++) {
        trailPositions[i * 3] = params.position.x;
        trailPositions[i * 3 + 1] = params.position.y;
        trailPositions[i * 3 + 2] = params.position.z;
      }

      const trailGeometry = new THREE.BufferGeometry();
      trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
      trailGeometry.setAttribute('color', new THREE.BufferAttribute(trailColors, 3));
      trailGeometry.setDrawRange(0, 0);

      const trailMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
      });
      const trailLine = new THREE.Line(trailGeometry, trailMat);
      trailLine.frustumCulled = false;
      trailLine.visible = simConfigRef.current.showTrails;
      scene.add(trailLine);

      const body: CelestialBodyData = {
        id,
        name: params.name,
        archetype: params.archetype,
        mass: params.mass,
        radius,
        colorHex: params.colorHex,
        position: params.position.clone(),
        velocity: params.velocity.clone(),
        acceleration: new THREE.Vector3(),
        meshGroup,
        spinSpeed: params.archetype === 'star' ? 0.35 : 0.8 + Math.random() * 0.9,
        trailPositions,
        trailColors,
        trailGeometry,
        trailLine,
        trailHead: 0,
        trailCount: 0,
        pointLight,
        isStar: params.archetype === 'star',
      };

      bodies.push(body);
      return body;
    }

    function disposeBody(body: CelestialBodyData) {
      scene.remove(body.meshGroup);
      body.meshGroup.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const m = obj as THREE.Mesh;
          m.geometry.dispose();
          if (Array.isArray(m.material)) {
            m.material.forEach((mat) => mat.dispose());
          } else if (m.material) {
            m.material.dispose();
          }
        }
      });
      scene.remove(body.trailLine);
      body.trailGeometry.dispose();
      (body.trailLine.material as THREE.Material).dispose();
    }

    function clearAllBodies(keepStars: boolean) {
      for (let i = bodies.length - 1; i >= 0; i--) {
        if (keepStars && bodies[i].isStar) continue;
        disposeBody(bodies[i]);
        bodies.splice(i, 1);
      }
      if (!keepStars) {
        simElapsedYears = 0;
        totalCollisions = 0;
      }
      if (
        simConfigRef.current.selectedBodyId &&
        !bodies.some((b) => b.id === simConfigRef.current.selectedBodyId)
      ) {
        simConfigRef.current.selectedBodyId = bodies[0]?.id ?? null;
      }
    }

    // -------------------------------------------------------------------------
    // 5. Curated Astronomical Preset Systems
    // -------------------------------------------------------------------------
    function loadPresetSystem(preset: PresetSystemId) {
      clearAllBodies(false);
      const G = BASE_G * simConfigRef.current.gravityMultiplier;

      if (preset === 'solar') {
        const starMass = 1000;
        const sol = addCelestialBody({
          name: 'Helios Prime',
          archetype: 'star',
          mass: starMass,
          position: new THREE.Vector3(0, 0, 0),
          velocity: new THREE.Vector3(0, 0, 0),
          colorHex: '#f59e0b',
        });

        const planetSpecs: Array<{
          name: string;
          archetype: Exclude<BodyArchetype, 'star'>;
          mass: number;
          dist: number;
          angle: number;
          incDeg: number;
          eccFactor: number;
          colorHex: string;
        }> = [
          {
            name: 'Pyros I',
            archetype: 'volcanic',
            mass: 2.2,
            dist: 15,
            angle: 0.4,
            incDeg: 3.5,
            eccFactor: 0.98,
            colorHex: '#ef4444',
          },
          {
            name: 'Gaia Nova',
            archetype: 'terran',
            mass: 4.5,
            dist: 24,
            angle: 2.1,
            incDeg: 0.0,
            eccFactor: 1.0,
            colorHex: '#38bdf8',
          },
          {
            name: 'Pelagia',
            archetype: 'oceanic',
            mass: 7.0,
            dist: 35,
            angle: 3.9,
            incDeg: -2.2,
            eccFactor: 1.02,
            colorHex: '#0284c7',
          },
          {
            name: 'Hyperion V',
            archetype: 'gas_giant',
            mass: 28.0,
            dist: 52,
            angle: 5.1,
            incDeg: 1.8,
            eccFactor: 1.0,
            colorHex: '#f59e0b',
          },
          {
            name: 'Borealis IX',
            archetype: 'ice_giant',
            mass: 15.0,
            dist: 72,
            angle: 1.2,
            incDeg: -5.5,
            eccFactor: 0.96,
            colorHex: '#2dd4bf',
          },
        ];

        const totalMomentum = new THREE.Vector3();
        for (const p of planetSpecs) {
          const x = Math.cos(p.angle) * p.dist;
          const z = Math.sin(p.angle) * p.dist;
          const incRad = THREE.MathUtils.degToRad(p.incDeg);
          const y = Math.sin(incRad) * p.dist * 0.25;

          const vCirc = Math.sqrt((G * starMass) / p.dist) * p.eccFactor;
          const vx = -Math.sin(p.angle) * vCirc * Math.cos(incRad);
          const vz = Math.cos(p.angle) * vCirc * Math.cos(incRad);
          const vy = Math.sin(incRad) * vCirc;

          const vel = new THREE.Vector3(vx, vy, vz);
          totalMomentum.addScaledVector(vel, p.mass);

          addCelestialBody({
            name: p.name,
            archetype: p.archetype,
            mass: p.mass,
            position: new THREE.Vector3(x, y, z),
            velocity: vel,
            colorHex: p.colorHex,
          });
        }

        // Balance central star velocity so system barycenter doesn't drift
        sol.velocity.copy(totalMomentum).divideScalar(-starMass);
        simConfigRef.current.selectedBodyId = bodies[2]?.id ?? sol.id;
      } else if (preset === 'binary') {
        const m1 = 680;
        const m2 = 520;
        const totalM = m1 + m2;
        const sep = 22;
        const r1 = (sep * m2) / totalM;
        const r2 = (sep * m1) / totalM;

        const vOrb = Math.sqrt((G * totalM) / sep);
        const v1 = (vOrb * m2) / totalM;
        const v2 = (vOrb * m1) / totalM;

        addCelestialBody({
          name: 'Alpha Aurelia',
          archetype: 'star',
          mass: m1,
          position: new THREE.Vector3(-r1, 0, 0),
          velocity: new THREE.Vector3(0, 0, v1),
          colorHex: '#f59e0b',
        });

        addCelestialBody({
          name: 'Beta Companion',
          archetype: 'star',
          mass: m2,
          position: new THREE.Vector3(r2, 0, 0),
          velocity: new THREE.Vector3(0, 0, -v2),
          colorHex: '#fb923c',
        });

        // Circumbinary planets
        const cbSpecs = [
          { name: 'Tatooine Prime', arch: 'terran' as const, mass: 4.5, dist: 46, angle: 0.8, col: '#38bdf8' },
          { name: 'Zephyr Giant', arch: 'gas_giant' as const, mass: 22.0, dist: 68, angle: 3.6, col: '#fbbf24' },
          { name: 'Cryo Horizon', arch: 'ice_giant' as const, mass: 13.0, dist: 90, angle: 5.2, col: '#2dd4bf' },
        ];
        for (const p of cbSpecs) {
          const v = Math.sqrt((G * totalM) / p.dist);
          addCelestialBody({
            name: p.name,
            archetype: p.arch,
            mass: p.mass,
            position: new THREE.Vector3(Math.cos(p.angle) * p.dist, 0, Math.sin(p.angle) * p.dist),
            velocity: new THREE.Vector3(-Math.sin(p.angle) * v, 0, Math.cos(p.angle) * v),
            colorHex: p.col,
          });
        }
        simConfigRef.current.selectedBodyId = bodies[0]?.id ?? null;
      } else if (preset === 'figure8') {
        // Chenciner-Montgomery 3-Body Figure-8 Periodic Choreography scaled to 3D units
        const mass = 380;
        const scaleR = 26;
        const scaleV = Math.sqrt((G * mass) / scaleR);

        // Normalized exact figure-8 initial conditions
        const x1 = 0.97000436 * scaleR;
        const z1 = -0.24308753 * scaleR;
        const vx3 = -0.93240737 * scaleV;
        const vz3 = -0.86473146 * scaleV;

        addCelestialBody({
          name: 'Triad Alpha',
          archetype: 'star',
          mass,
          position: new THREE.Vector3(x1, 0, z1),
          velocity: new THREE.Vector3(-vx3 / 2, 0, -vz3 / 2),
          colorHex: '#f59e0b',
        });
        addCelestialBody({
          name: 'Triad Beta',
          archetype: 'star',
          mass,
          position: new THREE.Vector3(-x1, 0, -z1),
          velocity: new THREE.Vector3(-vx3 / 2, 0, -vz3 / 2),
          colorHex: '#38bdf8',
        });
        addCelestialBody({
          name: 'Triad Gamma',
          archetype: 'star',
          mass,
          position: new THREE.Vector3(0, 0, 0),
          velocity: new THREE.Vector3(vx3, 0, vz3),
          colorHex: '#34d399',
        });
        simConfigRef.current.selectedBodyId = bodies[2]?.id ?? null;
      } else if (preset === 'trojan') {
        // High-mass Star + Super-Jupiter + L4 & L5 Lagrange Point Worlds + Inner World
        const starMass = 1100;
        addCelestialBody({
          name: 'Sol Invictus',
          archetype: 'star',
          mass: starMass,
          position: new THREE.Vector3(0, 0, 0),
          velocity: new THREE.Vector3(0, 0, 0),
          colorHex: '#f59e0b',
        });

        const jupDist = 48;
        const jupSpeed = Math.sqrt((G * starMass) / jupDist);
        addCelestialBody({
          name: 'Gargantua',
          archetype: 'gas_giant',
          mass: 42.0,
          position: new THREE.Vector3(jupDist, 0, 0),
          velocity: new THREE.Vector3(0, 0, jupSpeed),
          colorHex: '#f59e0b',
        });

        // L4 (+60 deg) and L5 (-60 deg) Trojan companions
        const l4Angle = Math.PI / 3;
        addCelestialBody({
          name: 'Achilles (L4 Trojan)',
          archetype: 'terran',
          mass: 2.0,
          position: new THREE.Vector3(Math.cos(l4Angle) * jupDist, 0, Math.sin(l4Angle) * jupDist),
          velocity: new THREE.Vector3(-Math.sin(l4Angle) * jupSpeed, 0, Math.cos(l4Angle) * jupSpeed),
          colorHex: '#38bdf8',
        });

        const l5Angle = -Math.PI / 3;
        addCelestialBody({
          name: 'Patroclus (L5 Trojan)',
          archetype: 'oceanic',
          mass: 2.0,
          position: new THREE.Vector3(Math.cos(l5Angle) * jupDist, 0, Math.sin(l5Angle) * jupDist),
          velocity: new THREE.Vector3(-Math.sin(l5Angle) * jupSpeed, 0, Math.cos(l5Angle) * jupSpeed),
          colorHex: '#2dd4bf',
        });

        const innerDist = 22;
        const innerSpeed = Math.sqrt((G * starMass) / innerDist);
        addCelestialBody({
          name: 'Vulcan Core',
          archetype: 'volcanic',
          mass: 5.5,
          position: new THREE.Vector3(0, 0, -innerDist),
          velocity: new THREE.Vector3(-innerSpeed, 0, 0),
          colorHex: '#ef4444',
        });
        simConfigRef.current.selectedBodyId = bodies[1]?.id ?? null;
      }
    }

    // Initialize with Solar System preset
    loadPresetSystem('solar');
    renderer.compile(scene, camera);

    // -------------------------------------------------------------------------
    // 6. N-Body Gravitational Acceleration & Velocity Verlet Integrator
    // -------------------------------------------------------------------------
    function computeAccelerations(G: number) {
      const n = bodies.length;
      for (let i = 0; i < n; i++) {
        bodies[i].acceleration.set(0, 0, 0);
      }
      for (let i = 0; i < n; i++) {
        const bi = bodies[i];
        for (let j = i + 1; j < n; j++) {
          const bj = bodies[j];
          _diff.subVectors(bj.position, bi.position);
          const distSq = _diff.lengthSq() + SOFTENING_SQ;
          const invDist = 1 / Math.sqrt(distSq);
          const invDist3 = invDist * invDist * invDist;
          const scalar = G * invDist3;

          bi.acceleration.addScaledVector(_diff, scalar * bj.mass);
          bj.acceleration.addScaledVector(_diff, -scalar * bi.mass);
        }
      }
    }

    // Compute acceleration on a test particle at `pos` due to all existing bodies
    function evaluateFieldAcceleration(pos: THREE.Vector3, G: number, outAcc: THREE.Vector3) {
      outAcc.set(0, 0, 0);
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        _diff.subVectors(b.position, pos);
        const distSq = _diff.lengthSq() + SOFTENING_SQ;
        const invDist = 1 / Math.sqrt(distSq);
        const factor = G * b.mass * invDist * invDist * invDist;
        outAcc.addScaledVector(_diff, factor);
      }
    }

    // 4th-Order Runge-Kutta (RK4) trajectory predictor for interactive launch or active body
    const _rkPos = new THREE.Vector3();
    const _rkVel = new THREE.Vector3();
    const _k1v = new THREE.Vector3();
    const _k1x = new THREE.Vector3();
    const _k2v = new THREE.Vector3();
    const _k2x = new THREE.Vector3();
    const _k3v = new THREE.Vector3();
    const _k3x = new THREE.Vector3();
    const _k4v = new THREE.Vector3();
    const _k4x = new THREE.Vector3();
    const _rkTempPos = new THREE.Vector3();

    function updateRK4PredictionLine(
      startPos: THREE.Vector3,
      startVel: THREE.Vector3,
      colorHex: string
    ): { collided: boolean } {
      const G = BASE_G * simConfigRef.current.gravityMultiplier;
      const h = 0.085;
      _rkPos.copy(startPos);
      _rkVel.copy(startVel);
      _baseColor.set(colorHex);

      let collided = false;
      let validSteps = PREDICTION_STEPS;

      for (let step = 0; step < PREDICTION_STEPS; step++) {
        predPositions[step * 3] = _rkPos.x;
        predPositions[step * 3 + 1] = _rkPos.y;
        predPositions[step * 3 + 2] = _rkPos.z;

        const fade = Math.pow(1 - step / PREDICTION_STEPS, 0.75);
        predColors[step * 3] = _baseColor.r * fade + (1 - fade) * 0.05;
        predColors[step * 3 + 1] = _baseColor.g * fade + (1 - fade) * 0.08;
        predColors[step * 3 + 2] = _baseColor.b * fade + (1 - fade) * 0.15;

        // Check if trajectory intersects any body radius
        for (let bIdx = 0; bIdx < bodies.length; bIdx++) {
          const b = bodies[bIdx];
          if (_rkPos.distanceToSquared(b.position) < (b.radius * 1.05) ** 2) {
            collided = true;
            validSteps = step + 1;
            break;
          }
        }
        if (collided) break;

        // RK4 integration step
        evaluateFieldAcceleration(_rkPos, G, _k1v);
        _k1x.copy(_rkVel);

        _rkTempPos.copy(_rkPos).addScaledVector(_k1x, h * 0.5);
        evaluateFieldAcceleration(_rkTempPos, G, _k2v);
        _k2x.copy(_rkVel).addScaledVector(_k1v, h * 0.5);

        _rkTempPos.copy(_rkPos).addScaledVector(_k2x, h * 0.5);
        evaluateFieldAcceleration(_rkTempPos, G, _k3v);
        _k3x.copy(_rkVel).addScaledVector(_k2v, h * 0.5);

        _rkTempPos.copy(_rkPos).addScaledVector(_k3x, h);
        evaluateFieldAcceleration(_rkTempPos, G, _k4v);
        _k4x.copy(_rkVel).addScaledVector(_k3v, h);

        _rkPos.addScaledVector(_k1x, h / 6);
        _rkPos.addScaledVector(_k2x, h / 3);
        _rkPos.addScaledVector(_k3x, h / 3);
        _rkPos.addScaledVector(_k4x, h / 6);

        _rkVel.addScaledVector(_k1v, h / 6);
        _rkVel.addScaledVector(_k2v, h / 3);
        _rkVel.addScaledVector(_k3v, h / 3);
        _rkVel.addScaledVector(_k4v, h / 6);
      }

      predGeo.setDrawRange(0, validSteps);
      predGeo.attributes.position.needsUpdate = true;
      predGeo.attributes.color.needsUpdate = true;
      return { collided };
    }

    // -------------------------------------------------------------------------
    // 7. Interactive Click & Drag Slingshot Launch Handler
    // -------------------------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    const pointerNDC = new THREE.Vector2();
    const launchPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    let isDraggingLaunch = false;
    const launchStartWorld = new THREE.Vector3();
    const launchCurrentVel = new THREE.Vector3();
    let pointerDownScreen = { x: 0, y: 0 };

    function getPrimaryStar(): CelestialBodyData | null {
      let heaviest: CelestialBodyData | null = null;
      for (let i = 0; i < bodies.length; i++) {
        if (!heaviest || bodies[i].mass > heaviest.mass) {
          heaviest = bodies[i];
        }
      }
      return heaviest;
    }

    function computeCircularVelocityAt(pos: THREE.Vector3, outVel: THREE.Vector3): number {
      const primary = getPrimaryStar();
      const G = BASE_G * simConfigRef.current.gravityMultiplier;
      if (!primary) {
        outVel.set(0, 0, 0);
        return 0;
      }
      _relPos.subVectors(pos, primary.position);
      const r = Math.max(2.0, _relPos.length());
      const vMag = Math.sqrt((G * primary.mass) / r);

      // Tangential direction in orbital plane tilted by user's inclination slider
      _tangentDir.set(-_relPos.z, 0, _relPos.x).normalize();
      const incRad = THREE.MathUtils.degToRad(simConfigRef.current.launchInclination);
      outVel.set(
        _tangentDir.x * vMag * Math.cos(incRad),
        Math.sin(incRad) * vMag,
        _tangentDir.z * vMag * Math.cos(incRad)
      );
      outVel.add(primary.velocity);
      return vMag;
    }

    function updatePointerRay(e: PointerEvent): boolean {
      const rect = renderer.domElement.getBoundingClientRect();
      pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNDC, camera);
      return raycaster.ray.intersectPlane(launchPlane, _rayPlaneIntersect) !== null;
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return; // Only left click initiates launch or selection
      pointerDownScreen = { x: e.clientX, y: e.clientY };

      const rect = renderer.domElement.getBoundingClientRect();
      pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNDC, camera);

      // Check if clicking directly on an existing celestial body
      const bodyGroups = bodies.map((b) => b.meshGroup);
      const hits = raycaster.intersectObjects(bodyGroups, true);
      if (hits.length > 0 && !e.shiftKey) {
        let obj: THREE.Object3D | null = hits[0].object;
        while (obj && !obj.userData.bodyId) {
          obj = obj.parent;
        }
        if (obj?.userData.bodyId) {
          simConfigRef.current.selectedBodyId = obj.userData.bodyId;
          return;
        }
      }

      // If in 'launch' mode (or holding Shift in 'orbit' mode), start Slingshot Launch!
      const shouldLaunch =
        simConfigRef.current.interactionMode === 'launch' || e.shiftKey;
      if (!shouldLaunch) return;

      if (!updatePointerRay(e)) return;

      controls.enabled = false;
      isDraggingLaunch = true;
      launchStartWorld.copy(_rayPlaneIntersect);

      const arch = simConfigRef.current.launchArchetype;
      const spec = ARCHETYPE_SPECS[arch];
      const previewRadius = computeRadiusFromMass(simConfigRef.current.launchMass, arch);

      launchGroup.position.copy(launchStartWorld);
      ghostSphereMesh.scale.setScalar(previewRadius);
      ghostSphereMat.color.set(spec.color);
      ghostSphereMat.emissive.set(spec.accentColor);
      ghostRingMesh.scale.setScalar(previewRadius * 1.15);
      launchGroup.visible = true;

      // Default initial velocity when clicking (auto-circular velocity so even a quick click or slight drag works intuitively)
      const circSpeed = computeCircularVelocityAt(launchStartWorld, launchCurrentVel);

      velocityArrow.position.copy(launchStartWorld);
      const speed = launchCurrentVel.length();
      if (speed > 0.05) {
        _arrowDir.copy(launchCurrentVel).normalize();
        velocityArrow.setDirection(_arrowDir);
        velocityArrow.setLength(Math.max(2.5, speed * 0.9), 1.4, 0.8);
        velocityArrow.visible = true;
      }

      const { collided } = updateRK4PredictionLine(
        launchStartWorld,
        launchCurrentVel,
        spec.color
      );
      predictionLine.visible = true;

      setLaunchPreview({
        active: true,
        speed,
        radiusFromCenter: launchStartWorld.length(),
        circularSpeed: circSpeed,
        eccentricity: 0.0,
        orbitClassification: collided ? 'Collision Course' : 'Circular Bound',
        inclinationDeg: simConfigRef.current.launchInclination,
      });
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDraggingLaunch) return;
      if (!updatePointerRay(e)) return;

      const arch = simConfigRef.current.launchArchetype;
      const spec = ARCHETYPE_SPECS[arch];
      const primary = getPrimaryStar();
      const G = BASE_G * simConfigRef.current.gravityMultiplier;

      const dragPixelDist = Math.hypot(
        e.clientX - pointerDownScreen.x,
        e.clientY - pointerDownScreen.y
      );

      const circSpeed = computeCircularVelocityAt(launchStartWorld, _velStep);

      if (simConfigRef.current.autoCircularize || dragPixelDist < 8) {
        // Use exact circular velocity vector (flip direction if user drags opposite side)
        launchCurrentVel.copy(_velStep);
        if (dragPixelDist >= 8) {
          _dragVec.subVectors(_rayPlaneIntersect, launchStartWorld);
          if (_dragVec.dot(_velStep) < 0) {
            launchCurrentVel.negate();
          }
        }
      } else {
        // Slingshot / Vector Drag: dragging sets velocity magnitude & direction
        _dragVec.subVectors(_rayPlaneIntersect, launchStartWorld);
        const rawSpeed = _dragVec.length() * 0.55;
        const incRad = THREE.MathUtils.degToRad(simConfigRef.current.launchInclination);
        const dirXZ = _dragVec.clone().normalize();

        launchCurrentVel.set(
          dirXZ.x * rawSpeed * Math.cos(incRad),
          Math.sin(incRad) * rawSpeed,
          dirXZ.z * rawSpeed * Math.cos(incRad)
        );
        if (primary) {
          launchCurrentVel.add(primary.velocity);
        }
      }

      const speed = launchCurrentVel.length();
      if (speed > 0.05) {
        _arrowDir.copy(launchCurrentVel).normalize();
        velocityArrow.setDirection(_arrowDir);
        velocityArrow.setLength(Math.min(36, Math.max(2.5, speed * 0.95)), 1.5, 0.85);
        velocityArrow.visible = true;
      } else {
        velocityArrow.visible = false;
      }

      const { collided } = updateRK4PredictionLine(
        launchStartWorld,
        launchCurrentVel,
        spec.color
      );

      // Compute Keplerian eccentricity relative to primary star for HUD readout
      let ecc = 0;
      let classification: LaunchPreviewTelemetry['orbitClassification'] = 'Elliptical Bound';
      if (collided) {
        classification = 'Collision Course';
      } else if (primary) {
        const mu = G * (primary.mass + simConfigRef.current.launchMass);
        _relPos.subVectors(launchStartWorld, primary.position);
        _relVel.subVectors(launchCurrentVel, primary.velocity);
        const r = Math.max(0.5, _relPos.length());
        const vSq = _relVel.lengthSq();
        _angMomentum.crossVectors(_relPos, _relVel);
        _eccVec
          .crossVectors(_relVel, _angMomentum)
          .divideScalar(mu)
          .sub(_relPos.clone().divideScalar(r));
        ecc = _eccVec.length();

        if (ecc >= 0.995 || vSq / 2 - mu / r >= 0) {
          classification = 'Hyperbolic Escape';
        } else if (ecc < 0.08) {
          classification = 'Circular Bound';
        } else {
          classification = 'Elliptical Bound';
        }
      }

      setLaunchPreview({
        active: true,
        speed,
        radiusFromCenter: primary ? launchStartWorld.distanceTo(primary.position) : launchStartWorld.length(),
        circularSpeed: circSpeed,
        eccentricity: ecc,
        orbitClassification: classification,
        inclinationDeg: simConfigRef.current.launchInclination,
      });
    };

    const finishLaunch = () => {
      if (!isDraggingLaunch) return;
      isDraggingLaunch = false;
      controls.enabled = true;
      launchGroup.visible = false;
      velocityArrow.visible = false;
      predictionLine.visible = false;

      const arch = simConfigRef.current.launchArchetype;
      const spec = ARCHETYPE_SPECS[arch];
      const mass = simConfigRef.current.launchMass;

      const newBody = addCelestialBody({
        name: `${spec.label.split(' ')[0]} ${bodies.length}`,
        archetype: arch,
        mass,
        position: launchStartWorld,
        velocity: launchCurrentVel,
        colorHex: spec.color,
      });

      simConfigRef.current.selectedBodyId = newBody.id;
      soundEngine.playLaunch(mass, launchCurrentVel.length());

      setLaunchPreview((prev) => ({ ...prev, active: false }));
    };

    const canvasEl = renderer.domElement;
    canvasEl.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finishLaunch);

    // Expose imperative actions to React UI
    sceneActionsRef.current = {
      loadPreset: (preset: PresetSystemId) => {
        loadPresetSystem(preset);
      },
      clearPlanets: () => {
        clearAllBodies(true);
      },
      deleteSelectedBody: () => {
        const selId = simConfigRef.current.selectedBodyId;
        if (!selId) return;
        const idx = bodies.findIndex((b) => b.id === selId);
        if (idx !== -1) {
          disposeBody(bodies[idx]);
          bodies.splice(idx, 1);
          simConfigRef.current.selectedBodyId = bodies[0]?.id ?? null;
        }
      },
      spawnCircularPlanet: () => {
        const arch = simConfigRef.current.launchArchetype;
        const spec = ARCHETYPE_SPECS[arch];
        const mass = simConfigRef.current.launchMass;
        const dist = 20 + Math.random() * 48;
        const angle = Math.random() * Math.PI * 2;
        const pos = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
        const vel = new THREE.Vector3();
        computeCircularVelocityAt(pos, vel);

        const created = addCelestialBody({
          name: `${spec.label.split(' ')[0]} ${bodies.length}`,
          archetype: arch,
          mass,
          position: pos,
          velocity: vel,
          colorHex: spec.color,
        });
        simConfigRef.current.selectedBodyId = created.id;
        soundEngine.playLaunch(mass, vel.length());
      },
      resetCamera: () => {
        controls.target.set(0, 0, 0);
        camera.position.set(0, 68, 96);
        controls.update();
      },
    };

    // -------------------------------------------------------------------------
    // 8. Main Animation, Symplectic Physics & Spacetime Grid Loop
    // -------------------------------------------------------------------------
    const clock = new THREE.Clock();
    let frameCounter = 0;
    let animFrameId = 0;

    const animate = () => {
      animFrameId = requestAnimationFrame(animate);

      const rawDelta = Math.min(clock.getDelta(), 0.05);
      const cfg = simConfigRef.current;
      const G = BASE_G * cfg.gravityMultiplier;

      // Update OrbitControls left-mouse behavior based on mode
      controls.mouseButtons.LEFT =
        cfg.interactionMode === 'orbit' ? THREE.MOUSE.ROTATE : (-1 as unknown as THREE.MOUSE);

      // Physics Sub-stepping (Velocity Verlet) when not paused
      if (!cfg.isPaused && cfg.timeSpeed > 0 && bodies.length > 0) {
        const subSteps = 6;
        const dt = (rawDelta * cfg.timeSpeed * 1.45) / subSteps;

        computeAccelerations(G);

        for (let s = 0; s < subSteps; s++) {
          // 1. Half-step velocity & full-step position
          for (let i = 0; i < bodies.length; i++) {
            const b = bodies[i];
            b.velocity.addScaledVector(b.acceleration, 0.5 * dt);
            b.position.addScaledVector(b.velocity, dt);
          }

          // 2. Recompute N-body gravitational accelerations at new positions
          computeAccelerations(G);

          // 3. Complete second half-step velocity
          for (let i = 0; i < bodies.length; i++) {
            const b = bodies[i];
            b.velocity.addScaledVector(b.acceleration, 0.5 * dt);
          }

          // 4. Inelastic Planetary Collisions & Accretion
          for (let i = 0; i < bodies.length; i++) {
            for (let j = i + 1; j < bodies.length; j++) {
              const bi = bodies[i];
              const bj = bodies[j];
              const dist = bi.position.distanceTo(bj.position);
              if (dist < (bi.radius + bj.radius) * 0.78) {
                // Heavier body absorbs lighter body conserving momentum
                const survivor = bi.mass >= bj.mass ? bi : bj;
                const absorbed = bi.mass >= bj.mass ? bj : bi;
                const absorbedIdx = bi.mass >= bj.mass ? j : i;

                const newMass = survivor.mass + absorbed.mass;
                survivor.velocity
                  .multiplyScalar(survivor.mass)
                  .addScaledVector(absorbed.velocity, absorbed.mass)
                  .divideScalar(newMass);
                survivor.position
                  .multiplyScalar(survivor.mass)
                  .addScaledVector(absorbed.position, absorbed.mass)
                  .divideScalar(newMass);

                survivor.mass = newMass;
                const newRadius = computeRadiusFromMass(newMass, survivor.archetype);
                const scaleFactor = newRadius / survivor.radius;
                survivor.meshGroup.scale.multiplyScalar(scaleFactor);
                survivor.radius = newRadius;

                spawnCollisionShockwave(survivor.position, newRadius, survivor.colorHex);
                soundEngine.playCollision(newMass);
                totalCollisions++;

                if (cfg.selectedBodyId === absorbed.id) {
                  cfg.selectedBodyId = survivor.id;
                }

                disposeBody(absorbed);
                bodies.splice(absorbedIdx, 1);
                if (absorbedIdx === i) break;
                j--;
              }
            }
          }
        }

        simElapsedYears += rawDelta * cfg.timeSpeed * 0.12;
      }

      // Update 3D Mesh Transforms, Axial Rotation & Ring-Buffer Orbital Trails
      frameCounter++;
      const recordTrailPoint = !cfg.isPaused && cfg.timeSpeed > 0 && frameCounter % 2 === 0;

      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        b.meshGroup.position.copy(b.position);
        b.meshGroup.rotation.y += rawDelta * b.spinSpeed * (cfg.isPaused ? 0.15 : cfg.timeSpeed);

        // Rotate moonlet or solar prominence loops if present
        const moonPivot = b.meshGroup.getObjectByName('moon_pivot');
        if (moonPivot) {
          moonPivot.rotation.y += rawDelta * 2.4 * (cfg.isPaused ? 0.2 : cfg.timeSpeed);
        }

        b.trailLine.visible = cfg.showTrails;

        if (recordTrailPoint) {
          b.trailCount = Math.min(TRAIL_MAX_POINTS, b.trailCount + 1);
          // Shift positions backward cleanly inside typed array (320 floats = 960 elements, ultra-fast)
          b.trailPositions.copyWithin(3, 0, (TRAIL_MAX_POINTS - 1) * 3);
          b.trailPositions[0] = b.position.x;
          b.trailPositions[1] = b.position.y;
          b.trailPositions[2] = b.position.z;

          _baseColor.set(b.colorHex);
          for (let k = 0; k < b.trailCount; k++) {
            const fade = Math.pow(1 - k / b.trailCount, 1.35);
            b.trailColors[k * 3] = _baseColor.r * fade;
            b.trailColors[k * 3 + 1] = _baseColor.g * fade;
            b.trailColors[k * 3 + 2] = _baseColor.b * fade;
          }

          b.trailGeometry.setDrawRange(0, b.trailCount);
          b.trailGeometry.attributes.position.needsUpdate = true;
          b.trailGeometry.attributes.color.needsUpdate = true;
        }
      }

      // If not currently dragging a launch, optionally show RK4 future trajectory for the selected planet
      if (!isDraggingLaunch) {
        const selBody = bodies.find((b) => b.id === cfg.selectedBodyId);
        if (selBody && !selBody.isStar && cfg.showPredictedOrbits) {
          updateRK4PredictionLine(selBody.position, selBody.velocity, selBody.colorHex);
          predictionLine.visible = true;
        } else {
          predictionLine.visible = false;
        }
      }

      // Update Selection Reticle
      const selectedBody = bodies.find((b) => b.id === cfg.selectedBodyId) ?? null;
      if (selectedBody) {
        selectionReticle.visible = true;
        selectionReticle.position.copy(selectedBody.position);
        const pulseScale = selectedBody.radius * 1.35;
        selectionReticle.scale.setScalar(pulseScale);
        selectionReticle.rotation.z += rawDelta * 0.8;
      } else {
        selectionReticle.visible = false;
      }

      // Update Shockwave Rings
      for (let i = activeShockwaves.length - 1; i >= 0; i--) {
        const sw = activeShockwaves[i];
        sw.age += rawDelta;
        if (sw.age >= sw.maxAge) {
          scene.remove(sw.mesh);
          (sw.mesh.material as THREE.Material).dispose();
          activeShockwaves.splice(i, 1);
        } else {
          const t = sw.age / sw.maxAge;
          const ease = 1 - Math.pow(1 - t, 3);
          sw.mesh.scale.setScalar(1 + ease * sw.maxScale);
          (sw.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.85;
        }
      }

      // Update 3D Spacetime Gravity Potential Well Grid
      gravityGridMesh.visible = cfg.showGravityGrid;
      if (cfg.showGravityGrid) {
        const posAttr = gridPlaneGeo.attributes.position;
        const colAttr = gridPlaneGeo.attributes.color;
        for (let v = 0; v < gridVertexCount; v++) {
          const vx = posAttr.getX(v);
          const vz = posAttr.getZ(v);
          let potentialDepth = 0;
          for (let bIdx = 0; bIdx < bodies.length; bIdx++) {
            const b = bodies[bIdx];
            const dx = vx - b.position.x;
            const dz = vz - b.position.z;
            const dist = Math.sqrt(dx * dx + dz * dz + 14.0);
            potentialDepth -= (G * b.mass * 0.032) / dist;
          }
          const clampedY = Math.max(-24, potentialDepth);
          posAttr.setY(v, clampedY);

          const strain = Math.min(1, Math.abs(clampedY) / 14);
          // Subtle slate-indigo baseline transitioning to warm amber near deep gravity wells
          colAttr.setXYZ(
            v,
            0.18 + strain * 0.78,
            0.26 + strain * 0.42,
            0.42 - strain * 0.25
          );
        }
        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
      }

      // Smooth Exponential Camera Target Damping
      if (cfg.cameraFollowMode === 'selected' && selectedBody) {
        _camTargetDesired.copy(selectedBody.position);
        controls.target.lerp(_camTargetDesired, 1 - Math.exp(-8 * rawDelta));
      } else if (cfg.cameraFollowMode === 'barycenter' && bodies.length > 0) {
        _barycenter.set(0, 0, 0);
        let totalM = 0;
        for (let i = 0; i < bodies.length; i++) {
          _barycenter.addScaledVector(bodies[i].position, bodies[i].mass);
          totalM += bodies[i].mass;
        }
        if (totalM > 0) _barycenter.divideScalar(totalM);
        controls.target.lerp(_barycenter, 1 - Math.exp(-6 * rawDelta));
      }

      controls.update();
      renderer.render(scene, camera);

      // Sync Telemetry to React HUD every 8 frames (~7.5 Hz) to avoid React re-render overhead
      if (frameCounter % 8 === 0) {
        let totalM = 0;
        for (let i = 0; i < bodies.length; i++) totalM += bodies[i].mass;
        setSystemMetrics({
          bodyCount: bodies.length,
          totalMass: totalM,
          simYears: simElapsedYears,
          collisions: totalCollisions,
        });

        if (selectedBody) {
          const primary = getPrimaryStar();
          let distToPrimary = 0;
          let semiMajor: number | null = null;
          let ecc: number | null = null;
          let orbitType = selectedBody.isStar ? 'Stellar Primary' : 'Bound Orbit';

          if (primary && primary.id !== selectedBody.id) {
            _relPos.subVectors(selectedBody.position, primary.position);
            _relVel.subVectors(selectedBody.velocity, primary.velocity);
            distToPrimary = _relPos.length();
            const mu = G * (primary.mass + selectedBody.mass);
            const vSq = _relVel.lengthSq();
            const specificEnergy = vSq / 2 - mu / Math.max(0.5, distToPrimary);

            _angMomentum.crossVectors(_relPos, _relVel);
            _eccVec
              .crossVectors(_relVel, _angMomentum)
              .divideScalar(mu)
              .sub(_relPos.clone().divideScalar(Math.max(0.5, distToPrimary)));
            ecc = _eccVec.length();

            if (specificEnergy < 0) {
              semiMajor = -mu / (2 * specificEnergy);
              orbitType = ecc < 0.08 ? 'Circular Orbit' : 'Elliptical Orbit';
            } else {
              orbitType = 'Hyperbolic Escape';
            }
          }

          setSelectedTelemetry({
            id: selectedBody.id,
            name: selectedBody.name,
            archetype: selectedBody.archetype,
            mass: selectedBody.mass,
            radius: selectedBody.radius,
            speed: selectedBody.velocity.length(),
            distanceToPrimary: distToPrimary,
            semiMajorAxis: semiMajor,
            eccentricity: ecc,
            orbitType,
            colorHex: selectedBody.colorHex,
            isStar: !!selectedBody.isStar,
          });
        } else {
          setSelectedTelemetry(null);
        }
      }
    };

    animate();

    // Responsive Resize Handler
    const handleResize = () => {
      if (!mountEl) return;
      const w = mountEl.clientWidth;
      const h = Math.max(1, mountEl.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animFrameId);
      window.removeEventListener('resize', handleResize);
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishLaunch);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mountEl) {
        mountEl.removeChild(renderer.domElement);
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Render Ergonomic HUD (Top Bar Contract + Unobstructed 3D Center + Bottom Dock)
  // ---------------------------------------------------------------------------
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#06080f] select-none">
      {/* Dedicated Isolated WebGL Canvas Container */}
      <div
        ref={canvasMountRef}
        className={`w-full h-full ${
          interactionMode === 'launch' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
        }`}
      />

      {/* Top Bar Contract: Zone 1 (Brand) — Zone 2 (System Presets) — Zone 3 (Primary Action) */}
      <header className="fixed top-0 left-0 right-0 z-20 flex items-center justify-between gap-8 px-6 py-3.5 bg-[#090d16]/95 border-b border-white/10">
        {/* Zone 1: Brand Wordmark */}
        <div className="flex items-center gap-6 shrink-0">
          <span className="font-display text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
            Kepleria 3D
          </span>
          <div className="hidden lg:flex items-center gap-2 text-xs text-slate-400 font-mono tabular-nums whitespace-nowrap">
            <span>{systemMetrics.bodyCount} Bodies</span>
            <span aria-hidden="true">·</span>
            <span>{systemMetrics.totalMass.toFixed(0)} M☉</span>
            <span aria-hidden="true">·</span>
            <span>T+{systemMetrics.simYears.toFixed(1)} yr</span>
            {systemMetrics.collisions > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-amber-400">{systemMetrics.collisions} Mergers</span>
              </>
            )}
          </div>
        </div>

        {/* Zone 2: Curated Orbital Preset Links */}
        <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-slate-400">
          {(
            [
              { id: 'solar', label: 'Solar System' },
              { id: 'binary', label: 'Binary Stars' },
              { id: 'figure8', label: 'Figure-8 Choreography' },
              { id: 'trojan', label: 'Lagrange Trojans' },
            ] as const
          ).map((preset) => (
            <button
              key={preset.id}
              onClick={() => {
                setActivePreset(preset.id);
                sceneActionsRef.current?.loadPreset(preset.id);
              }}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                activePreset === preset.id
                  ? 'text-amber-400 border-amber-400 font-semibold'
                  : 'border-transparent hover:text-slate-100'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </nav>

        {/* Zone 3: Single Primary Action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => sceneActionsRef.current?.spawnCircularPlanet()}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Launch Circular Orbit</span>
          </button>
        </div>
      </header>

      {/* Subtle Top-Left Contextual Telemetry Bar (Interactive Launch or Selected Body Readout) */}
      <div className="fixed top-16 left-6 z-10 pointer-events-none flex flex-col gap-2 max-w-md">
        {launchPreview.active ? (
          <div className="pointer-events-auto px-4 py-3 rounded-xl bg-[#090d16]/95 border border-amber-500/40 text-xs text-slate-200 shadow-lg">
            <div className="flex items-center justify-between gap-4 mb-1">
              <span className="font-display font-semibold text-amber-400">
                Slingshot Trajectory Preview
              </span>
              <span className="font-mono text-slate-300">{launchPreview.orbitClassification}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-slate-400 tabular-nums">
              <span>v₀: {launchPreview.speed.toFixed(1)} km/s</span>
              <span aria-hidden="true">·</span>
              <span>v_circ: {launchPreview.circularSpeed.toFixed(1)} km/s</span>
              <span aria-hidden="true">·</span>
              <span>e: {Math.min(9.99, launchPreview.eccentricity).toFixed(2)}</span>
              <span aria-hidden="true">·</span>
              <span>r: {launchPreview.radiusFromCenter.toFixed(1)} AU</span>
            </div>
          </div>
        ) : selectedTelemetry ? (
          <div className="pointer-events-auto px-4 py-2.5 rounded-xl bg-[#090d16]/92 border border-white/10 text-xs text-slate-300 flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: selectedTelemetry.colorHex }}
              />
              <span className="font-display font-semibold text-slate-100 whitespace-nowrap">
                {selectedTelemetry.name}
              </span>
            </div>
            <div className="flex items-center gap-2 font-mono text-slate-400 tabular-nums whitespace-nowrap">
              <span>{selectedTelemetry.mass.toFixed(1)} M⊕</span>
              <span aria-hidden="true">·</span>
              <span>{selectedTelemetry.speed.toFixed(1)} km/s</span>
              {selectedTelemetry.eccentricity !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>e={Math.min(9.9, selectedTelemetry.eccentricity).toFixed(2)}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="text-slate-300">{selectedTelemetry.orbitType}</span>
            </div>
            <div className="flex items-center gap-1 ml-1">
              <button
                onClick={() =>
                  setCameraFollowMode((m) => (m === 'selected' ? 'free' : 'selected'))
                }
                title="Track selected body with camera"
                className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                  cameraFollowMode === 'selected'
                    ? 'bg-amber-400/20 text-amber-300'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-white/5'
                }`}
              >
                <Focus className="w-3.5 h-3.5" />
              </button>
              {!selectedTelemetry.isStar && (
                <button
                  onClick={() => sceneActionsRef.current?.deleteSelectedBody()}
                  title="Remove body"
                  className="p-1.5 rounded-md text-slate-400 hover:text-rose-400 hover:bg-white/5 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ) : null}

        {/* Quiet Single-Line Gesture Hint */}
        <div className="text-xs text-slate-400 px-1">
          {interactionMode === 'launch'
            ? 'Left-click & drag anywhere on the orbital plane to launch a planet · Right-drag or scroll to orbit camera'
            : 'Left-drag to orbit camera · Hold Shift + Left-drag to launch a new planet'}
        </div>
      </div>

      {/* Unified Collapsible Bottom Control Dock (Zero Viewport Occlusion) */}
      <div
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-20 w-[min(980px,95vw)] transition-transform duration-200 ease-out"
        style={{
          transform: dockCollapsed
            ? 'translate(-50%, calc(100% - 34px))'
            : 'translate(-50%, 0)',
        }}
      >
        {/* Mass Units (M⊕) & Planetary Archetype Scale Legend Popover */}
        {showMassLegend && !dockCollapsed && (
          <div
            role="dialog"
            aria-label="Mass Units and Planetary Archetype Scale Legend"
            className="mb-2.5 p-4 rounded-2xl bg-[#090d16]/98 border border-white/15 shadow-2xl text-xs text-slate-300"
          >
            <div className="flex items-start justify-between gap-4 pb-3 mb-3 border-b border-white/10">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-100">
                  Mass Units (M⊕) & Planetary Archetype Scaling Guide
                </h2>
                <p className="text-slate-400 mt-0.5 leading-relaxed">
                  <strong className="text-amber-400 font-mono">1 M⊕</strong> equals one{' '}
                  <strong className="text-slate-200">Earth Mass</strong> (
                  <span className="font-mono">5.97 × 10²⁴ kg</span>). Central stars are measured in{' '}
                  <strong className="text-amber-400 font-mono">M☉</strong> (Solar Masses,{' '}
                  <span className="font-mono">1,000 sim units</span>). Planet radius scales with cube-root
                  volume (<span className="font-mono text-slate-200">R ∝ M⁰·³⁴</span>), while gravitational
                  pull and spacetime grid curvature scale linearly with mass (
                  <span className="font-mono text-slate-200">F ∝ G · M</span>).
                </p>
              </div>
              <button
                onClick={() => setShowMassLegend(false)}
                title="Close legend"
                className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/10 transition-colors cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Archetype Scale Breakdown Table */}
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
              {(
                Object.keys(ARCHETYPE_SPECS) as Array<Exclude<BodyArchetype, 'star'>>
              ).map((arch) => {
                const spec = ARCHETYPE_SPECS[arch];
                const isSelected = launchArchetype === arch;
                return (
                  <button
                    key={arch}
                    onClick={() => handleSelectArchetype(arch)}
                    className={`text-left p-2.5 rounded-xl border transition-colors cursor-pointer flex flex-col justify-between gap-1.5 ${
                      isSelected
                        ? 'bg-white/10 border-amber-400/60'
                        : 'bg-white/[0.03] border-white/8 hover:bg-white/[0.06]'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: spec.color }}
                        />
                        <span className="font-display font-semibold text-slate-100 truncate">
                          {spec.label}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-amber-400 tabular-nums">
                        {spec.massRange}
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-snug">
                      {spec.description}
                    </p>
                    <div className="pt-1 border-t border-white/5 flex items-center justify-between text-[11px] font-mono text-slate-400 tabular-nums">
                      <span>Default: {spec.defaultMass.toFixed(1)} M⊕</span>
                      <span>
                        R≈{(0.65 * Math.pow(spec.defaultMass, 0.34)).toFixed(1)}x
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Collapse / Expand Zen Mode Tab */}
        <div className="flex justify-center mb-1.5">
          <button
            onClick={() => setDockCollapsed((prev) => !prev)}
            className="flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-[#0b101b]/95 border border-white/10 text-xs font-medium text-slate-300 hover:text-white transition-colors cursor-pointer whitespace-nowrap"
          >
            {dockCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5 text-amber-400" />
                <span>Show Controls (H)</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                <span>Hide Controls (H)</span>
              </>
            )}
          </button>
        </div>

        {/* Main Dock Surface */}
        <div className="bg-[#090d16]/96 border border-white/12 rounded-2xl p-4 shadow-2xl">
          {/* Top Row: Planet Launcher Archetypes, Mode Switch & Visual Toggles */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3.5 mb-3.5 border-b border-white/10">
            {/* Left: Interaction Mode Switcher (Launch vs Orbit) */}
            <div className="flex items-center gap-1 p-1 bg-[#111726] rounded-xl border border-white/5">
              <button
                onClick={() => setInteractionMode('launch')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  interactionMode === 'launch'
                    ? 'bg-amber-400 text-slate-950 font-semibold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Crosshair className="w-3.5 h-3.5" />
                <span>Drag to Launch</span>
              </button>
              <button
                onClick={() => setInteractionMode('orbit')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  interactionMode === 'orbit'
                    ? 'bg-amber-400 text-slate-950 font-semibold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Compass className="w-3.5 h-3.5" />
                <span>Camera Orbit</span>
              </button>
            </div>

            {/* Center: 5 Procedural Planet Archetypes with Mass Range Tooltips */}
            <div className="flex items-center gap-1.5 overflow-x-auto py-0.5">
              {(
                Object.keys(ARCHETYPE_SPECS) as Array<Exclude<BodyArchetype, 'star'>>
              ).map((arch) => {
                const spec = ARCHETYPE_SPECS[arch];
                const active = launchArchetype === arch;
                return (
                  <button
                    key={arch}
                    onClick={() => handleSelectArchetype(arch)}
                    title={`${spec.label} (${spec.massRange}, default ${spec.defaultMass} M⊕): ${spec.description}`}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer border ${
                      active
                        ? 'bg-white/12 text-white border-amber-400/60'
                        : 'bg-white/[0.03] text-slate-400 border-white/5 hover:text-slate-200 hover:bg-white/[0.06]'
                    }`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: spec.color }}
                    />
                    <span>{spec.label}</span>
                    <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                      {spec.defaultMass}M⊕
                    </span>
                  </button>
                );
              })}

              {/* M⊕ Scale Legend Toggle Button */}
              <button
                onClick={() => setShowMassLegend((v) => !v)}
                title="View M⊕ mass units & planetary archetype scaling legend"
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  showMassLegend
                    ? 'bg-amber-400/20 text-amber-300 border-amber-400/50'
                    : 'bg-white/[0.03] text-slate-400 border-white/5 hover:text-slate-200'
                }`}
              >
                <Info className="w-3.5 h-3.5" />
                <span>M⊕ Legend</span>
              </button>
            </div>

            {/* Right: Visual Layer Toggles & Reset */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => setAutoCircularize((v) => !v)}
                title="Auto-snap launch velocity to circular orbit speed (Shortcut: C)"
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  autoCircularize
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-white/[0.03] text-slate-400 border-white/5 hover:text-slate-200'
                }`}
              >
                <Orbit className="w-3.5 h-3.5" />
                <span>Circular Assist</span>
              </button>

              <button
                onClick={() => setShowTrails((v) => !v)}
                title="Toggle orbital path trails (Shortcut: T)"
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  showTrails
                    ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                    : 'bg-white/[0.03] text-slate-400 border-white/5 hover:text-slate-200'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Trails</span>
              </button>

              <button
                onClick={() => setShowGravityGrid((v) => !v)}
                title="Toggle 3D spacetime gravity potential well grid (Shortcut: G)"
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  showGravityGrid
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-white/[0.03] text-slate-400 border-white/5 hover:text-slate-200'
                }`}
              >
                <Grid className="w-3.5 h-3.5" />
                <span>Gravity Well</span>
              </button>

              <button
                onClick={() => setShowPredictedOrbits((v) => !v)}
                title="Toggle RK4 future orbit prediction line"
                className={`p-1.5 rounded-lg border transition-colors cursor-pointer ${
                  showPredictedOrbits
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-white/[0.03] text-slate-400 border-white/5 hover:text-slate-200'
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={() => {
                  const next = !audioEnabled;
                  setAudioEnabled(next);
                  soundEngine.enabled = next;
                }}
                title="Toggle acoustic synthesizer"
                className="p-1.5 rounded-lg bg-white/[0.03] text-slate-400 border border-white/5 hover:text-slate-200 transition-colors cursor-pointer"
              >
                {audioEnabled ? (
                  <Volume2 className="w-3.5 h-3.5 text-amber-400" />
                ) : (
                  <VolumeX className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          {/* Bottom Row: Precision Physics Sliders & Playback Controls */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
            {/* Play / Pause & Clear Actions (3 cols) */}
            <div className="md:col-span-3 flex items-center gap-2">
              <button
                onClick={() => setIsPaused((p) => !p)}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {isPaused ? (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Resume</span>
                  </>
                ) : (
                  <>
                    <Pause className="w-3.5 h-3.5 fill-current" />
                    <span>Pause</span>
                  </>
                )}
              </button>

              <button
                onClick={() => sceneActionsRef.current?.clearPlanets()}
                title="Clear launched planets (keep stars)"
                className="px-2.5 py-2 rounded-xl bg-white/[0.05] hover:bg-white/10 text-slate-300 border border-white/10 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Clear Planets
              </button>

              <button
                onClick={() => {
                  sceneActionsRef.current?.loadPreset(activePreset);
                  sceneActionsRef.current?.resetCamera();
                }}
                title="Reset current star system & camera"
                className="p-2 rounded-xl bg-white/[0.05] hover:bg-white/10 text-slate-300 border border-white/10 transition-colors shrink-0 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Gravity Constant (G) Slider (3 cols) */}
            <div className="md:col-span-3 flex flex-col gap-1.5 px-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400 font-medium">Gravity Constant (G)</span>
                <span className="font-mono text-amber-400 font-semibold tabular-nums">
                  {gravityMultiplier.toFixed(2)}x
                </span>
              </div>
              <input
                type="range"
                min="0.1"
                max="3.0"
                step="0.05"
                value={gravityMultiplier}
                onChange={(e) => setGravityMultiplier(parseFloat(e.target.value))}
                className="sim-slider w-full"
              />
            </div>

            {/* Time Speed Slider (3 cols) */}
            <div className="md:col-span-3 flex flex-col gap-1.5 px-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400 font-medium">Time Speed</span>
                <span className="font-mono text-sky-400 font-semibold tabular-nums">
                  {isPaused ? 'Paused' : `${timeSpeed.toFixed(2)}x`}
                </span>
              </div>
              <input
                type="range"
                min="0.05"
                max="4.0"
                step="0.05"
                value={timeSpeed}
                onChange={(e) => {
                  setTimeSpeed(parseFloat(e.target.value));
                  if (isPaused) setIsPaused(false);
                }}
                className="sim-slider w-full"
              />
            </div>

            {/* Launch Mass & 3D Inclination Sliders (3 cols) */}
            <div className="md:col-span-3 flex flex-col gap-1.5 px-2">
              <div className="flex items-center justify-between text-xs">
                <button
                  onClick={() => setShowMassLegend((v) => !v)}
                  title="Click to toggle M⊕ mass units & archetype scaling guide"
                  className="flex items-center gap-1 text-slate-400 hover:text-slate-200 font-medium transition-colors cursor-pointer"
                >
                  <span>Launch Mass & Tilt</span>
                  <Info className="w-3 h-3 text-amber-400/80" />
                </button>
                <span className="font-mono text-emerald-400 font-semibold tabular-nums">
                  {launchMass.toFixed(1)} M⊕ · {launchInclination}°
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="0.5"
                  max="50.0"
                  step="0.5"
                  value={launchMass}
                  onChange={(e) => setLaunchMass(parseFloat(e.target.value))}
                  title="Planet Launch Mass in Earth Masses (M⊕)"
                  className="sim-slider w-2/3"
                />
                <input
                  type="range"
                  min="-40"
                  max="40"
                  step="5"
                  value={launchInclination}
                  onChange={(e) => setLaunchInclination(parseFloat(e.target.value))}
                  title="3D Orbital Inclination Angle (Degrees)"
                  className="sim-slider w-1/3"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
