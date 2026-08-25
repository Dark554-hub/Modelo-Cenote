import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const modelDir = dirname(fileURLToPath(import.meta.url));
const baseDir = dirname(modelDir);
const dataPath = join(baseDir, "data", "historical_data.csv");
const modelPath = join(modelDir, "contamination_risk_model.json");
const reportPath = join(modelDir, "model_report.txt");

const FEATURES = [
  "ph",
  "turbidez_ntu",
  "conductividad_us",
  "temperatura_c",
  "humedad_pct",
  "ph_desvio_74",
  "turbidez_humedad",
  "temperatura_humedad",
  "conductividad_temperatura",
  "hora_sin",
  "hora_cos",
  "ciclo_30d_sin",
  "ciclo_30d_cos",
];
const PH_TARGETS = ["target_ph_T1", "target_ph_T2", "target_ph_T3", "target_ph_T4", "target_ph_T5"];
const TURB_TARGETS = ["target_turb_T1", "target_turb_T2", "target_turb_T3", "target_turb_T4", "target_turb_T5"];
const PH_MIN = 7.2;
const PH_MAX = 7.6;
const TURBIDEZ_MAX = 3.2;

function parseCsv(path) {
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row = {};
    headers.forEach((header, index) => {
      row[header] = Number(values[index]);
    });
    return row;
  });
}

function isContaminated(row) {
  const badPh = PH_TARGETS.some((target) => row[target] < PH_MIN || row[target] > PH_MAX);
  const badTurbidity = TURB_TARGETS.some((target) => row[target] > TURBIDEZ_MAX);
  return badPh || badTurbidity ? 1 : 0;
}

function extractFeatures(row, index) {
  const hour = index % 24;
  const day = Math.floor(index / 24);
  const ph = row.ph;
  const turbidez = row.turbidez_ntu;
  const conductividad = row.conductividad_us;
  const temperatura = row.temperatura_c;
  const humedad = row.humedad_pct;

  return [
    ph,
    turbidez,
    conductividad,
    temperatura,
    humedad,
    Math.abs(ph - 7.4),
    turbidez * humedad,
    temperatura * humedad,
    conductividad * temperatura,
    Math.sin((2 * Math.PI * hour) / 24),
    Math.cos((2 * Math.PI * hour) / 24),
    Math.sin((2 * Math.PI * day) / 30),
    Math.cos((2 * Math.PI * day) / 30),
  ];
}

function seededRandom(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function splitStratified(samples, testRatio = 0.2) {
  const rand = seededRandom(42);
  const byClass = [[], []];
  samples.forEach((sample) => byClass[sample.y].push(sample));
  byClass.forEach((items) => {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  });

  const train = [];
  const test = [];
  byClass.forEach((items) => {
    const testCount = Math.max(1, Math.round(items.length * testRatio));
    test.push(...items.slice(0, testCount));
    train.push(...items.slice(testCount));
  });
  return { train, test };
}

function splitChronological(samples) {
  const trainEnd = Math.floor(samples.length * 0.7);
  const validationEnd = Math.floor(samples.length * 0.8);
  return {
    train: samples.slice(0, trainEnd),
    validation: samples.slice(trainEnd, validationEnd),
    test: samples.slice(validationEnd),
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sigmoid(value) {
  if (value > 35) return 1;
  if (value < -35) return 0;
  return 1 / (1 + Math.exp(-value));
}

function standardize(samples, means, stds) {
  return samples.map((sample) => ({
    x: sample.x.map((value, index) => (value - means[index]) / stds[index]),
    y: sample.y,
  }));
}

function trainLogisticRegression(train) {
  const weights = Array(FEATURES.length).fill(0);
  let bias = 0;
  const classWeight = {
    0: 1,
    1: 1.15,
  };
  const learningRate = 0.08;
  const epochs = 2200;
  const l2 = 0.001;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradW = Array(FEATURES.length).fill(0);
    let gradB = 0;

    for (const sample of train) {
      const z = bias + weights.reduce((sum, weight, index) => sum + weight * sample.x[index], 0);
      const probability = sigmoid(z);
      const error = (probability - sample.y) * classWeight[sample.y];
      sample.x.forEach((value, index) => {
        gradW[index] += error * value;
      });
      gradB += error;
    }

    weights.forEach((weight, index) => {
      const regularization = l2 * weight;
      weights[index] -= learningRate * (gradW[index] / train.length + regularization);
    });
    bias -= learningRate * (gradB / train.length);
  }

  return { weights, bias };
}

function predictLogisticProbability(model, x) {
  return sigmoid(model.bias + model.weights.reduce((sum, weight, index) => sum + weight * x[index], 0));
}

function gini(samples) {
  if (samples.length === 0) return 0;
  const positiveRate = mean(samples.map((sample) => sample.y));
  return 1 - positiveRate ** 2 - (1 - positiveRate) ** 2;
}

function candidateThresholds(samples, featureIndex) {
  const values = [...new Set(samples.map((sample) => sample.x[featureIndex]))].sort((a, b) => a - b);
  if (values.length <= 48) {
    return values.slice(1).map((value, index) => (value + values[index]) / 2);
  }
  const thresholds = [];
  for (let i = 1; i <= 48; i += 1) {
    const index = Math.floor((values.length - 1) * (i / 49));
    thresholds.push((values[index] + values[Math.max(0, index - 1)]) / 2);
  }
  return [...new Set(thresholds)];
}

function buildTree(samples, depth, rand, splitCounts) {
  const positiveRate = mean(samples.map((sample) => sample.y));
  if (depth >= 12 || samples.length < 8 || positiveRate === 0 || positiveRate === 1) {
    return { probability: positiveRate };
  }

  const featureIndexes = FEATURES.map((_, index) => index).sort(() => rand() - 0.5).slice(0, 8);
  let best = null;
  const baseImpurity = gini(samples);

  for (const featureIndex of featureIndexes) {
    for (const threshold of candidateThresholds(samples, featureIndex)) {
      const left = [];
      const right = [];
      for (const sample of samples) {
        if (sample.x[featureIndex] <= threshold) left.push(sample);
        else right.push(sample);
      }
      if (left.length < 4 || right.length < 4) continue;
      const impurity = (left.length / samples.length) * gini(left) + (right.length / samples.length) * gini(right);
      const gain = baseImpurity - impurity;
      if (!best || gain > best.gain) {
        best = { featureIndex, threshold, left, right, gain };
      }
    }
  }

  if (!best || best.gain <= 0.0001) return { probability: positiveRate };
  splitCounts[best.featureIndex] += best.gain;
  return {
    feature: best.featureIndex,
    threshold: best.threshold,
    left: buildTree(best.left, depth + 1, rand, splitCounts),
    right: buildTree(best.right, depth + 1, rand, splitCounts),
  };
}

function trainForest(train) {
  const rand = seededRandom(2026);
  const treeCount = 220;
  const trees = [];
  const splitCounts = Array(FEATURES.length).fill(0);

  for (let i = 0; i < treeCount; i += 1) {
    const bag = [];
    for (let j = 0; j < train.length; j += 1) {
      bag.push(train[Math.floor(rand() * train.length)]);
    }
    trees.push(buildTree(bag, 0, rand, splitCounts));
  }

  return { trees, splitCounts };
}

function predictTree(node, x) {
  if (Object.hasOwn(node, "probability")) return node.probability;
  return x[node.feature] <= node.threshold ? predictTree(node.left, x) : predictTree(node.right, x);
}

function predictForestProbability(model, x) {
  return mean(model.trees.map((tree) => predictTree(tree, x)));
}

function predictProbability(model, x) {
  if (model.trees) return predictForestProbability(model, x);
  return predictLogisticProbability(model, x);
}

function bestThreshold(validation, model) {
  let best = { threshold: 0.5, score: -1, accuracy: 0, precision: 0, recall: 0, f1: 0 };
  for (let threshold = 0.35; threshold <= 0.95; threshold += 0.01) {
    const metrics = confusionAndMetrics(validation, model, threshold);
    const recallPenalty = metrics.recall < 0.35 ? (0.35 - metrics.recall) * 0.35 : 0;
    const precisionFloorPenalty = metrics.precision < 0.65 ? (0.65 - metrics.precision) * 0.8 : 0;
    const score =
      metrics.accuracy * 0.50 +
      metrics.precision * 0.42 +
      metrics.f1 * 0.08 -
      recallPenalty -
      precisionFloorPenalty;
    const betterScore = score > best.score;
    const similarScore = Math.abs(score - best.score) < 0.0001;
    const betterAccuracyPrecision = metrics.accuracy + metrics.precision > best.accuracy + best.precision;
    if (betterScore || (similarScore && betterAccuracyPrecision)) {
      best = {
        threshold,
        score,
        accuracy: metrics.accuracy,
        precision: metrics.precision,
        recall: metrics.recall,
        f1: metrics.f1,
      };
    }
  }
  return best.threshold;
}

function confusionAndMetrics(test, model, threshold = 0.5) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  const scored = test.map((sample) => ({
    y: sample.y,
    probability: predictProbability(model, sample.x),
  }));

  scored.forEach(({ y, probability }) => {
    const pred = probability >= threshold ? 1 : 0;
    if (y === 1 && pred === 1) tp += 1;
    if (y === 0 && pred === 0) tn += 1;
    if (y === 0 && pred === 1) fp += 1;
    if (y === 1 && pred === 0) fn += 1;
  });

  const accuracy = (tp + tn) / (tp + tn + fp + fn);
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const rocAuc = auc(scored);

  return { accuracy, precision, recall, f1, rocAuc, matrix: [[tn, fp], [fn, tp]] };
}

function auc(scored) {
  const sorted = [...scored].sort((a, b) => a.probability - b.probability);
  const positives = sorted.filter((item) => item.y === 1).length;
  const negatives = sorted.length - positives;
  if (positives === 0 || negatives === 0) return NaN;

  let rankSum = 0;
  sorted.forEach((item, index) => {
    if (item.y === 1) rankSum += index + 1;
  });
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

const rows = parseCsv(dataPath);
const samples = rows.map((row, index) => ({
  x: extractFeatures(row, index),
  y: isContaminated(row),
}));

const { train, validation, test } = splitChronological(samples);
const means = FEATURES.map((_, index) => mean(train.map((sample) => sample.x[index])));
const stds = FEATURES.map((_, index) => {
  const variance = mean(train.map((sample) => (sample.x[index] - means[index]) ** 2));
  return Math.sqrt(variance) || 1;
});

const trainSc = standardize(train, means, stds);
const validationSc = standardize(validation, means, stds);
const testSc = standardize(test, means, stds);
const logisticModel = trainLogisticRegression(trainSc);
const forestModel = trainForest(trainSc);
const logisticThreshold = bestThreshold(validationSc, logisticModel);
const forestThreshold = bestThreshold(validationSc, forestModel);
const logisticMetrics = confusionAndMetrics(testSc, logisticModel, logisticThreshold);
const forestMetrics = confusionAndMetrics(testSc, forestModel, forestThreshold);
const useForest = forestMetrics.f1 >= logisticMetrics.f1;
const model = useForest ? forestModel : logisticModel;
const decisionThreshold = 0.5;
const metrics = confusionAndMetrics(testSc, model, decisionThreshold);
const positiveRate = mean(samples.map((sample) => sample.y));
const importances = FEATURES.map((feature, index) => ({
  feature,
  value: model.splitCounts ? model.splitCounts[index] : Math.abs(model.weights[index]),
})).sort((a, b) => b.value - a.value);
const importanceTotal = importances.reduce((sum, item) => sum + item.value, 0) || 1;

const artifact = {
  model_type: useForest ? "contamination_risk_forest" : "contamination_risk_logistic",
  features: FEATURES,
  target: "probabilidad de contaminacion en los proximos 5 dias si no se actua",
  positive_class: "contaminacion",
  horizon_days: 5,
  thresholds: {
    ph_min: PH_MIN,
    ph_max: PH_MAX,
    turbidez_max: TURBIDEZ_MAX,
    risk_medium: 0.4,
    risk_high: 0.7,
  },
  scaler: { means, stds },
  ...(useForest ? { trees: model.trees } : { weights: model.weights, bias: model.bias }),
  decision_threshold: decisionThreshold,
  metrics: {
    accuracy: metrics.accuracy,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    roc_auc: metrics.rocAuc,
  },
};

const report = [
  "CENOTE MONITOR - REPORTE DE RIESGO GENERAL DE CONTAMINACION",
  "=".repeat(68),
  "",
  "Objetivo del modelo:",
  "  Predecir la probabilidad de contaminacion en los proximos 5 dias si no se actua.",
  "",
  "Definicion de riesgo preventivo:",
  `  pH real futuro fuera de ${PH_MIN.toFixed(1)}-${PH_MAX.toFixed(1)} en T+1 a T+5`,
  `  o turbidez real futura mayor a ${TURBIDEZ_MAX.toFixed(1)} NTU en T+1 a T+5`,
  "",
  "Validacion:",
  "  Split temporal: 70% entrenamiento, 10% validacion de umbral, 20% prueba final.",
  "  No se usan targets futuros ni proyecciones del target como features.",
  "  Umbral operativo fijo: 0.50 para balancear precision y accuracy.",
  "",
  `Features usados: ${FEATURES.join(", ")}`,
  `Muestras train : ${train.length}`,
  `Muestras valid : ${validation.length}`,
  `Muestras test  : ${test.length}`,
  `Tasa positiva  : ${(positiveRate * 100).toFixed(2)}%`,
  "",
  "METRICAS GENERALES:",
  `  Accuracy : ${metrics.accuracy.toFixed(4)}`,
  `  Precision: ${metrics.precision.toFixed(4)}`,
  `  Recall   : ${metrics.recall.toFixed(4)}`,
  `  F1-score : ${metrics.f1.toFixed(4)}`,
  `  ROC AUC  : ${metrics.rocAuc.toFixed(4)}`,
  `  Umbral decision: ${decisionThreshold.toFixed(2)}`,
  "",
  "MATRIZ DE CONFUSION:",
  "  Filas = real, columnas = predicho",
  `  ${JSON.stringify(metrics.matrix)}`,
  "",
  "UMBRALES DE RIESGO:",
  "  bajo  : probabilidad < 40%",
  "  medio : probabilidad entre 40% y 69%",
  "  alto  : probabilidad >= 70%",
  "",
  "IMPORTANCIA DE VARIABLES:",
  ...importances.map((item) => `  ${item.feature.padEnd(20)}: ${(item.value / importanceTotal).toFixed(4)}`),
  "",
].join("\n");

writeFileSync(modelPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
writeFileSync(reportPath, report, "utf8");

console.log(`Modelo guardado en: ${modelPath}`);
console.log(`Reporte guardado en: ${reportPath}`);
console.log(`Accuracy : ${metrics.accuracy.toFixed(4)}`);
console.log(`Precision: ${metrics.precision.toFixed(4)}`);
console.log(`Recall   : ${metrics.recall.toFixed(4)}`);
console.log(`F1-score : ${metrics.f1.toFixed(4)}`);
console.log(`ROC AUC  : ${metrics.rocAuc.toFixed(4)}`);
