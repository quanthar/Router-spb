// ═══════════════════════════════════════════════
//  DOM references
// ═══════════════════════════════════════════════

const welcomeScreen = document.getElementById('welcome-screen');
const mapScreen     = document.getElementById('map-screen');
const routesList    = document.getElementById('routes-list');
const backBtn       = document.getElementById('back-btn');

let map = null;            // Leaflet map instance (created once)
let routingControl = null; // Current routing layer
let routesData = [];       // All routes from JSON

// ═══════════════════════════════════════════════
//  Geolocation state
// ═══════════════════════════════════════════════

const userIcon = L.divIcon({
  className: 'user-location-marker',
  iconSize: [20, 20],
  iconAnchor: [10, 10]
});

let userMarker = null;
let accuracyCircle = null;
let watchId = null;
let currentWaypoints = [];

// ═══════════════════════════════════════════════
//  1. Load routes & render cards
// ═══════════════════════════════════════════════

async function loadRoutes() {
  routesList.innerHTML = '<div class="routes-loading">Загрузка маршрутов…</div>';

  try {
    const res = await fetch('routes.json');
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    routesData = data.routes;
    renderRouteCards(routesData);
  } catch (e) {
    routesList.innerHTML = '<div class="routes-loading">Не удалось загрузить маршруты</div>';
    console.error('Error loading routes:', e);
  }
}

function renderRouteCards(routes) {
  routesList.innerHTML = '';

  routes.forEach((route) => {
    const card = document.createElement('div');
    card.className = 'route-card';
    card.addEventListener('click', () => openRoute(route));

    const highlightTags = route.highlights
      .map(h => `<span class="route-highlight-tag">${h}</span>`)
      .join('');

    card.innerHTML = `
      <div class="route-card-top">
        <div class="route-name">${route.name}</div>
        <div class="route-arrow">→</div>
      </div>
      <div class="route-meta">
        <span class="route-meta-item">🕐 ${route.duration}</span>
        <span class="route-meta-item">📏 ${route.distance}</span>
        <span class="route-meta-item">📍 ${route.waypoints.length} точек</span>
      </div>
      <div class="route-description">${route.description}</div>
      <div class="route-highlights">${highlightTags}</div>
    `;

    routesList.appendChild(card);
  });
}

// ═══════════════════════════════════════════════
//  2. Open selected route on the map
// ═══════════════════════════════════════════════

function openRoute(route) {
  // Switch screens
  welcomeScreen.classList.add('hidden');
  mapScreen.classList.remove('hidden');

  // Init map if first time
  if (!map) {
    map = L.map('map', { attributionControl: false })
      .setView([59.9343, 30.3351], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

    // Info panel
    const infoPanel = L.control({ position: 'topright' });
    infoPanel.onAdd = function () {
      const div = L.DomUtil.create('div', 'info-panel');
      div.innerHTML = 'Определяю местоположение…';
      return div;
    };
    infoPanel.addTo(map);

    // Locate-me button
    const locateBtn = L.control({ position: 'bottomright' });
    locateBtn.onAdd = function () {
      const btn = L.DomUtil.create('div', 'locate-btn');
      btn.innerHTML = '⊕';
      btn.title = 'Моё местоположение';
      btn.addEventListener('click', () => {
        if (userMarker && map.hasLayer(userMarker)) {
          map.flyTo(userMarker.getLatLng(), 16, { duration: 0.8 });
        }
      });
      return btn;
    };
    locateBtn.addTo(map);

    // Start geolocation
    startTracking();
  }

  // Leaflet needs a kick after display:none → block
  setTimeout(() => map.invalidateSize(), 50);

  // Build the route
  buildRoute(route);
}

// ═══════════════════════════════════════════════
//  Custom OpenRouteService Router
// ═══════════════════════════════════════════════

const ORSRouter = L.Class.extend({
  options: {
    // Obfuscated API key to prevent simple bots from scraping
    apiKey: ["eyJvcmci", "OiI1YjNjZ", "TM1OTc4N", "TExMTAwMD", "FjZjYyNDg", "iLCJpZCI6", "IjgxYzBh", "ZmI0N2IwM", "zQ4NTk5Y", "jQwYjkwNG", "QyNTA3NG", "Q2IiwiaC", "I6Im11cm", "11cjY0In0="].join(""),
    profile: 'foot-walking'
  },
  
  route: function(waypoints, callback, context, options) {
    const coords = waypoints.map(w => [w.latLng.lng, w.latLng.lat]);
    
    fetch(`https://api.openrouteservice.org/v2/directions/${this.options.profile}/geojson`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.options.apiKey
      },
      body: JSON.stringify({ coordinates: coords })
    })
    .then(res => {
      if (!res.ok) throw new Error('ORS Routing failed: ' + res.status);
      return res.json();
    })
    .then(data => {
      if (!data.features || !data.features.length) throw new Error('No route found');
      const feature = data.features[0];
      const routeData = {
        name: "ORS Route",
        summary: {
          totalDistance: feature.properties.summary.distance,
          totalTime: feature.properties.summary.duration
        },
        coordinates: feature.geometry.coordinates.map(c => L.latLng(c[1], c[0])),
        waypoints: waypoints,
        inputWaypoints: waypoints,
        waypointIndices: feature.properties.way_points || waypoints.map((_, i) => i === 0 ? 0 : (i === waypoints.length - 1 ? feature.geometry.coordinates.length - 1 : Math.floor(feature.geometry.coordinates.length * i / waypoints.length))),
        instructions: []
      };
      callback.call(context, null, [routeData]);
    })
    .catch(err => {
      console.error(err);
      callback.call(context, err, null);
    });
  }
});

function buildRoute(route) {
  // Remove old route if any
  if (routingControl) {
    map.removeControl(routingControl);
    routingControl = null;
  }

  currentWaypoints = route.waypoints;

  const latLngs = route.waypoints.map(p => L.latLng(p.lat, p.lng));

  routingControl = L.Routing.control({
    waypoints: latLngs,
    router: new ORSRouter(),
    lineOptions: {
      styles: [{ color: '#00A8FF', weight: 6, opacity: 0.85 }]
    },
    addWaypoints: false,
    fitSelectedRoutes: true,
    showAlternatives: false,
    createMarker: function(i, wp, nWps) {
      const marker = L.marker(wp.latLng);
      const data = route.waypoints[i];

      if (data && data.info) {
        let popupContent = `<div class="waypoint-popup">`;
        popupContent += `<div class="waypoint-title">${data.name}</div>`;
        
        if (data.info.story) {
          popupContent += `<div class="waypoint-info"><span class="info-icon">✨</span>${data.info.story}</div>`;
        }
        if (data.info.fact) {
          popupContent += `<div class="waypoint-info"><span class="info-icon">💡</span>${data.info.fact}</div>`;
        }
        if (data.info.rest) {
          popupContent += `<div class="waypoint-info"><span class="info-icon">☕</span>${data.info.rest}</div>`;
        }
        
        popupContent += `</div>`;
        
        marker.bindPopup(popupContent, {
          closeButton: false,
          className: 'custom-popup'
        });
      } else if (data && data.name) {
        marker.bindPopup(`<div class="waypoint-popup"><div class="waypoint-title">${data.name}</div></div>`, {
          closeButton: false,
          className: 'custom-popup'
        });
      }
      return marker;
    }
  }).addTo(map);
}

// ═══════════════════════════════════════════════
//  3. Back button — return to route selection
// ═══════════════════════════════════════════════

backBtn.addEventListener('click', () => {
  mapScreen.classList.add('hidden');
  welcomeScreen.classList.remove('hidden');
});

// ═══════════════════════════════════════════════
//  4. Geolocation tracking
// ═══════════════════════════════════════════════

function haversine(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function updateInfoPanel(userLatLng) {
  const panel = document.querySelector('.info-panel');
  if (!panel || currentWaypoints.length === 0) return;

  let minDist = Infinity;
  let nearestIdx = 0;
  currentWaypoints.forEach((wp, i) => {
    const d = haversine(userLatLng, wp);
    if (d < minDist) { minDist = d; nearestIdx = i; }
  });

  const distStr = minDist < 1000
    ? `${Math.round(minDist)} м`
    : `${(minDist / 1000).toFixed(1)} км`;

  const name = currentWaypoints[nearestIdx].name || `Точка ${nearestIdx + 1}`;

  panel.innerHTML = `
    <div class="info-title">📍 Ближайшая точка</div>
    <div class="info-name">${name}</div>
    <div class="info-dist">${distStr}</div>
  `;
}

function startTracking() {
  if (!('geolocation' in navigator)) {
    const p = document.querySelector('.info-panel');
    if (p) p.innerHTML = 'Геолокация недоступна';
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);

      if (!userMarker) {
        userMarker = L.marker(latlng, { icon: userIcon, zIndexOffset: 1000, interactive: false }).addTo(map);
        accuracyCircle = L.circle(latlng, {
          radius: pos.coords.accuracy,
          color: '#C19A5B',
          fillColor: '#C19A5B80',
          fillOpacity: 0.15,
          weight: 1,
          interactive: false
        }).addTo(map);
      } else {
        userMarker.setLatLng(latlng);
        accuracyCircle.setLatLng(latlng);
        accuracyCircle.setRadius(pos.coords.accuracy);
      }

      updateInfoPanel({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    },
    (err) => {
      console.warn('Geolocation error:', err.message);
      const p = document.querySelector('.info-panel');
      if (p) p.innerHTML = 'Нет доступа к геолокации';
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
  );
}

// ═══════════════════════════════════════════════
//  Boot
// ═══════════════════════════════════════════════

loadRoutes();
