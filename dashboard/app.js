const API_BASE = "http://localhost:8000";

Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = "'Outfit', sans-serif";

let chartTurb;

function initCharts() {
  chartTurb = new Chart(document.getElementById('chartTurbidez'), {
    type: 'line',
    data: {
      labels: ['Hoy', 'Día 1', 'Día 2', 'Día 3', 'Día 4', 'Día 5'],
      datasets: [
        {
          label: 'Turbidez (NTU)',
          data: [0, 0, 0, 0, 0, 0],
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56,189,248,0.15)',
          fill: true,
          tension: 0.4,
          pointBackgroundColor: '#38bdf8',
          pointRadius: 4,
        },
        {
          label: 'Límite típico (5 NTU)',
          data: [5, 5, 5, 5, 5, 5],
          borderColor: '#f43f5e',
          borderDash: [4, 4],
          pointRadius: 0,
          borderWidth: 1.5,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top' }
      },
      scales: {
        y: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          title: { display: true, text: 'NTU', color: '#64748b' }
        },
        x: { grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
}

function renderUI(data) {
  const actual = data.actual || data.actual_modificado;
  const p5d    = data.pronostico_5d;
  const tts    = p5d.turbidez_pred;
  const phs    = p5d.ph_pred;
  const m      = p5d.metricas_peor_dia;

  // Actualizar tarjetas de sensores
  document.getElementById('lblTemp').innerText         = actual.temperatura_c;
  document.getElementById('lblPh').innerText           = actual.ph;
  document.getElementById('lblTurbidez').innerText     = actual.turbidez_ntu;
  document.getElementById('lblConductividad').innerText = actual.conductividad_us;
  document.getElementById('lblHumedad').innerText      = actual.humedad_pct;

  // Título de estado
  const st = document.getElementById('statusTitle');
  if (m.bandera.includes("Verde")) {
    st.innerText = "ESTADO: CRISTALINO 🟢";
    st.style.color = "var(--safe)";
  } else if (m.bandera.includes("Amarilla")) {
    st.innerText = "ESTADO: EN RIESGO 🟡";
    st.style.color = "#facc15";
  } else {
    st.innerText = "ESTADO: CLAUSURA RIESGOSA 🔴";
    st.style.color = "var(--danger)";
  }

  // Tarjetas de pronóstico (Día 1 … Día 5)
  const row = document.getElementById('forecastRow');
  row.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    const isBad = (tts[i] > 4.5 || phs[i] < 6.5 || phs[i] > 8.5);
    const color = isBad ? 'var(--danger)' : 'var(--safe)';
    row.innerHTML += `
      <div class="day-card" style="border-top: 3px solid ${color}; background: ${isBad ? 'rgba(244,63,94,0.1)' : 'rgba(16,185,129,0.05)'}">
        <h4 style="margin:0 0 4px; font-size: 0.75rem; color: #cbd5e1;">DÍA ${i + 1}</h4>
        <div style="font-size: 1.05rem; font-weight:700; color: ${color}">${tts[i]} <span style="font-size:0.6rem;font-weight:300">NTU</span></div>
        <div style="font-size: 0.75rem; color: #94a3b8; margin-top:2px">pH ${phs[i]}</div>
      </div>
    `;
  }

  // Actualizar gráfico
  chartTurb.data.datasets[0].data = [actual.turbidez_ntu, ...tts];
  chartTurb.update();
}

async function simular(tipo, btnEl) {
  document.querySelectorAll('.sim-btn').forEach(btn => btn.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');

  if (tipo === 'ninguno') { return loadData(); }

  // Obtener lectura actual para usarla como base
  let actual;
  try {
    const r = await fetch(`${API_BASE}/current-reading`);
    const curr = await r.json();
    actual = curr.actual;
  } catch (e) {
    console.error("No se pudo obtener lectura base:", e);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/what-if`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ph:               actual.ph,
        turbidez_ntu:     actual.turbidez_ntu,
        conductividad_us: actual.conductividad_us,
        temperatura_c:    actual.temperatura_c,
        humedad_pct:      actual.humedad_pct,
        escenario:        tipo
      })
    });
    const data = await res.json();
    renderUI(data);
  } catch (e) {
    console.error("Error en simulación:", e);
  }
}

async function loadData() {
  try {
    const res  = await fetch(`${API_BASE}/current-reading`);
    const data = await res.json();
    renderUI(data);
  } catch (e) {
    console.error("API no disponible:", e);
  }
}

window.onload = () => {
  initCharts();
  loadData();
};
