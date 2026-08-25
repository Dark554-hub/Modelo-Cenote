import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const modelDir = dirname(fileURLToPath(import.meta.url));
const reportPath = join(modelDir, "model_report.txt");
const outputPath = join(modelDir, "model_accuracy_general.svg");

const report = readFileSync(reportPath, "utf8");
const metricMatches = [...report.matchAll(/^\s*(Accuracy|Precision|Recall|F1-score|ROC AUC)\s*:\s*([0-9.]+)/gim)];

if (metricMatches.length < 4) {
  throw new Error(
    "El reporte actual no contiene metricas del clasificador. Ejecuta primero: python models/train_model.py"
  );
}

const metrics = metricMatches.map((match) => ({
  name: match[1],
  value: Number(match[2]),
}));

const width = 920;
const height = 560;
const margin = { top: 92, right: 54, bottom: 92, left: 82 };
const plotW = width - margin.left - margin.right;
const plotH = height - margin.top - margin.bottom;
const barGap = 34;
const barW = (plotW - barGap * (metrics.length - 1)) / metrics.length;
const y = (value) => margin.top + (1 - value) * plotH;
const x = (index) => margin.left + index * (barW + barGap);
const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
const average = metrics.reduce((sum, metric) => sum + metric.value, 0) / metrics.length;

const grid = ticks
  .map((tick) => {
    const yy = y(tick);
    return `
      <line x1="${margin.left}" y1="${yy}" x2="${width - margin.right}" y2="${yy}" stroke="#d5dde3" stroke-width="1"/>
      <text x="${margin.left - 14}" y="${yy + 5}" text-anchor="end" font-size="15" fill="#4c5963">${tick.toFixed(1)}</text>`;
  })
  .join("");

const bars = metrics
  .map((metric, index) => {
    const xPos = x(index);
    const yPos = y(metric.value);
    const barHeight = margin.top + plotH - yPos;
    const color = metric.name === "Recall" ? "#d45d00" : metric.name === "ROC AUC" ? "#4f6d7a" : "#0f8b8d";
    return `
      <rect x="${xPos}" y="${yPos}" width="${barW}" height="${barHeight}" rx="6" fill="${color}"/>
      <text x="${xPos + barW / 2}" y="${yPos - 12}" text-anchor="middle" font-size="17" font-weight="700" fill="${color}">${metric.value.toFixed(3)}</text>
      <text x="${xPos + barW / 2}" y="${height - margin.bottom + 34}" text-anchor="middle" font-size="16" fill="#34424d">${metric.name}</text>`;
  })
  .join("");

const averageY = y(average);
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Accuracy general del modelo de riesgo de contaminacion">
  <rect width="100%" height="100%" fill="#f7faf9"/>
  <text x="${margin.left}" y="42" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#12212b">Accuracy general del modelo</text>
  <text x="${margin.left}" y="68" font-family="Arial, sans-serif" font-size="15" fill="#5d6b75">Clasificador de probabilidad de contaminacion a 5 dias. Promedio de metricas: ${average.toFixed(3)}</text>

  <g font-family="Arial, sans-serif">
    ${grid}
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#34424d" stroke-width="1.5"/>
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#34424d" stroke-width="1.5"/>
    <line x1="${margin.left}" y1="${averageY}" x2="${width - margin.right}" y2="${averageY}" stroke="#26343d" stroke-width="2" stroke-dasharray="8 7"/>
    <text x="${width - margin.right - 8}" y="${averageY - 8}" text-anchor="end" font-size="14" font-weight="700" fill="#26343d">Promedio ${average.toFixed(3)}</text>
    ${bars}
    <text x="28" y="${margin.top + plotH / 2}" transform="rotate(-90 28 ${margin.top + plotH / 2})" text-anchor="middle" font-size="16" font-weight="700" fill="#34424d">Puntaje</text>
    <text x="${margin.left + plotW / 2}" y="${height - 24}" text-anchor="middle" font-size="16" font-weight="700" fill="#34424d">Metricas generales del clasificador</text>
  </g>
</svg>`;

writeFileSync(outputPath, svg, "utf8");
console.log(`Grafica general guardada en: ${outputPath}`);
console.log(metrics.map((metric) => `${metric.name}: ${metric.value.toFixed(4)}`).join("\n"));
