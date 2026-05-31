/*
 * ============================================================
 *  FLOTAYA — ESP32 Boya Cenote
 *  Sensores: pH, Turbidez, Conductividad, Temperatura, Humedad
 *  Envía datos a la API Cenote Monitor cada INTERVALO segundos
 * ============================================================
 *
 *  Librerías necesarias (instalar en Arduino IDE):
 *   - ArduinoJson  (by Benoit Blanchon)
 *   - DHT sensor library (by Adafruit) — para humedad/temp ambiente
 *   - OneWire + DallasTemperature — para DS18B20 (temp agua)
 *   - HTTPClient (incluida en ESP32 board package)
 *
 *  Conexiones sugeridas:
 *   - pH sensor (analógico)       → GPIO 34
 *   - Turbidez (analógico)        → GPIO 35
 *   - Conductividad (analógico)   → GPIO 32
 *   - DS18B20 temperatura agua    → GPIO 4  (con resistencia 4.7kΩ a 3.3V)
 *   - DHT22 humedad/temp ambiente → GPIO 15
 * ============================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ─── Configuración WiFi ──────────────────────────────────────
const char* WIFI_SSID     = "TU_RED_WIFI";
const char* WIFI_PASSWORD = "TU_PASSWORD_WIFI";

// ─── URL de tu API ───────────────────────────────────────────
// Si corres la API local para pruebas, usa la IP local de tu laptop:
//   const char* API_URL = "http://192.168.1.X:8000/nueva-lectura";
// En producción (servidor con IP pública):
//   const char* API_URL = "http://TU_SERVIDOR_IP:8000/nueva-lectura";
const char* API_URL = "https://modelo-cenote.onrender.com/nueva-lectura";

// ─── Intervalo de envío ──────────────────────────────────────
const unsigned long INTERVALO_MS = 60000;  // cada 60 segundos

// ─── Pines ───────────────────────────────────────────────────
#define PIN_PH            34
#define PIN_TURBIDEZ      35
#define PIN_CONDUCTIVIDAD 32
#define PIN_DS18B20        4
#define PIN_DHT           15
#define TIPO_DHT          DHT22

// ─── Objetos sensores ─────────────────────────────────────────
DHT dht(PIN_DHT, TIPO_DHT);
OneWire oneWire(PIN_DS18B20);
DallasTemperature ds18b20(&oneWire);

unsigned long ultimoEnvio = 0;

// ─── Calibración pH ──────────────────────────────────────────
// Ajusta estos valores con tu solución buffer (pH 4 y pH 7)
float PH_OFFSET    = 0.0;
float PH_PENDIENTE = 1.0;

// ─── Setup ───────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== FLOTAYA BOYA INICIANDO ===");

  dht.begin();
  ds18b20.begin();

  // Conectar WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Conectando a WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n[OK] WiFi conectado: " + WiFi.localIP().toString());
}

// ─── Lectura de sensores ──────────────────────────────────────

float leerPH() {
  int raw = analogRead(PIN_PH);
  // ADC ESP32: 0-4095 → 0-3.3V
  float voltaje = raw * (3.3 / 4095.0);
  // Conversión típica pH analog: ajusta con tu sensor específico
  float ph = (voltaje * PH_PENDIENTE) + PH_OFFSET;
  // Rango válido
  ph = constrain(ph, 0.0, 14.0);
  return round(ph * 100.0) / 100.0;
}

float leerTurbidez() {
  int raw = analogRead(PIN_TURBIDEZ);
  float voltaje = raw * (3.3 / 4095.0);
  // Conversión aproximada (varía según sensor SEN0189 u otro)
  // Voltaje alto = agua clara; voltaje bajo = turbia
  float ntu = -1120.4 * voltaje * voltaje + 5742.3 * voltaje - 4353.8;
  ntu = max(0.0f, ntu);
  return round(ntu * 100.0) / 100.0;
}

float leerConductividad() {
  int raw = analogRead(PIN_CONDUCTIVIDAD);
  float voltaje = raw * (3.3 / 4095.0);
  // Conversión genérica — calibrar con solución estándar
  // Rango cenote: 450-650 μS/cm
  float us_cm = voltaje * 200.0 + 300.0;
  return round(us_cm * 10.0) / 10.0;
}

float leerTemperaturaAgua() {
  ds18b20.requestTemperatures();
  float temp = ds18b20.getTempCByIndex(0);
  if (temp == DEVICE_DISCONNECTED_C) {
    Serial.println("[WARN] DS18B20 desconectado");
    return -999.0;
  }
  return round(temp * 10.0) / 10.0;
}

float leerHumedad() {
  float h = dht.readHumidity();
  if (isnan(h)) {
    Serial.println("[WARN] DHT22 error lectura humedad");
    return -999.0;
  }
  return round(h * 10.0) / 10.0;
}

// ─── Envío a la API ───────────────────────────────────────────

void enviarDatos(float ph, float turbidez, float conductividad,
                 float temperatura, float humedad) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[ERROR] WiFi desconectado, intentando reconectar...");
    WiFi.reconnect();
    delay(3000);
    return;
  }

  // Construir JSON
  StaticJsonDocument<256> doc;
  doc["ph"]               = ph;
  doc["turbidez_ntu"]     = turbidez;
  doc["conductividad_us"] = conductividad;
  doc["temperatura_c"]    = temperatura;
  doc["humedad_pct"]      = humedad;

  String payload;
  serializeJson(doc, payload);

  Serial.println("\n[ENVIANDO] " + payload);

  HTTPClient http;
  http.begin(API_URL);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(15000);

  int httpCode = http.POST(payload);

  if (httpCode == 200 || httpCode == 201) {
    String respuesta = http.getString();
    Serial.println("[OK] API respondio: " + respuesta);

    // Parsear respuesta del modelo
    StaticJsonDocument<1024> resp;
    if (!deserializeJson(resp, respuesta)) {
      const char* bandera = resp["diagnostico"]["bandera"];
      float salud         = resp["diagnostico"]["salud_pct"];
      Serial.printf("[DIAGNOSTICO] Salud: %.1f%% | %s\n", salud, bandera);
    }
  } else {
    Serial.printf("[ERROR] HTTP %d\n", httpCode);
  }

  http.end();
}

// ─── Loop principal ───────────────────────────────────────────

void loop() {
  unsigned long ahora = millis();

  if (ahora - ultimoEnvio >= INTERVALO_MS) {
    ultimoEnvio = ahora;

    Serial.println("\n--- Leyendo sensores ---");

    float ph            = leerPH();
    float turbidez      = leerTurbidez();
    float conductividad = leerConductividad();
    float temperatura   = leerTemperaturaAgua();
    float humedad       = leerHumedad();

    Serial.printf("  pH:            %.2f\n",  ph);
    Serial.printf("  Turbidez:      %.2f NTU\n", turbidez);
    Serial.printf("  Conductividad: %.1f uS/cm\n", conductividad);
    Serial.printf("  Temperatura:   %.1f C\n", temperatura);
    Serial.printf("  Humedad:       %.1f %%\n", humedad);

    // Solo enviar si todos los sensores leyeron correctamente
    if (temperatura != -999.0 && humedad != -999.0) {
      enviarDatos(ph, turbidez, conductividad, temperatura, humedad);
    } else {
      Serial.println("[SKIP] Lectura invalida, no se envia.");
    }
  }

  delay(100);
}
