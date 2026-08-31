/*
  Smart Plant - Arduino Uno Soil Moisture Sensor + DHT11 + Pump Relay
  Serial: 115200
  Soil sensor AO -> A0
  DHT11 DATA/S -> D2
  Pump relay -> D7

  Install libraries: DHT sensor library by Adafruit and Adafruit Unified Sensor.

  ارفع هذا الملف إلى Arduino IDE ثم اختر Arduino Uno والمنفذ الصحيح.
*/

#include <DHT.h>

const byte SENSOR_PIN = A0;
const byte DHT_PIN = 2;
const byte DHT_TYPE = DHT11;
DHT dht(DHT_PIN, DHT_TYPE);
const byte PUMP_PIN = 7;

// غيّرها إلى false إذا كان الريليه Active-Low.
const bool PUMP_ACTIVE_HIGH = false;

// إرسال قراءة جديدة كل ثانية.
const unsigned long SAMPLE_INTERVAL_MS = 1000UL;

// إيقاف المضخة تلقائياً إذا لم تصل أوامر من التطبيق.
const unsigned long PUMP_WATCHDOG_MS = 15000UL;

const char* DEVICE_ID = "arduino-uno-soil-01";
const char* ZONE_ID = "zone2";

// معايرة ابتدائية شائعة للحساس.
// DRY_RAW: قراءة الحساس في تربة جافة.
// WET_RAW: قراءة الحساس في تربة رطبة.
const int DRY_RAW = 850;
const int WET_RAW = 350;

unsigned long lastSample = 0;
unsigned long lastPumpCommand = 0;
bool pumpOn = false;

void setPumpOutput(bool on, bool acknowledge) {
  pumpOn = on;
  digitalWrite(PUMP_PIN, (on == PUMP_ACTIVE_HIGH) ? HIGH : LOW);
  lastPumpCommand = millis();

  if (acknowledge) {
    Serial.print("PUMP_ACK:");
    Serial.println(on ? "ON" : "OFF");
  }
}

void processPumpCommands() {
  while (Serial.available() > 0) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "PUMP_ON") {
      setPumpOutput(true, true);
    } else if (command == "PUMP_OFF") {
      setPumpOutput(false, true);
    }
  }
}

int readRawAverage() {
  long total = 0;
  const byte samples = 10;

  for (byte i = 0; i < samples; i++) {
    total += analogRead(SENSOR_PIN);
    delay(20);
  }

  return (int)(total / samples);
}

int rawToPercent(int raw) {
  // أغلب حساسات رطوبة التربة تعطي قيمة أعلى عندما تكون التربة جافة.
  long percent = map(raw, DRY_RAW, WET_RAW, 0, 100);

  // مهم: value يجب أن تبقى دائماً بين 0 و100.
  return constrain((int)percent, 0, 100);
}

void publishReading() {
  int raw = readRawAverage();
  int moisture = rawToPercent(raw);
  float airHumidity = dht.readHumidity();
  float airTemperature = dht.readTemperature();
  bool airValid = !isnan(airHumidity) && !isnan(airTemperature);

  // أرسل القيمة المئوية في value، والقراءة الخام في raw.
  Serial.print("{\"ts_ms\":");
  Serial.print(millis());
  Serial.print(",\"zone\":\"");
  Serial.print(ZONE_ID);
  Serial.print("\",\"deviceId\":\"");
  Serial.print(DEVICE_ID);
  Serial.print("\",\"value\":");
  Serial.print(moisture);
  Serial.print(",\"raw\":");
  Serial.print(raw);
  Serial.print(",\"unit\":\"percent\",\"calibration\":\"uno-field-calibrated\"");
  if (airValid) {
    Serial.print(",\"airTemperature\":");
    Serial.print(airTemperature, 1);
    Serial.print(",\"airHumidity\":");
    Serial.print(airHumidity, 1);
    Serial.print(",\"airUnit\":\"C/%\"");
  } else {
    Serial.print(",\"airTemperature\":null,\"airHumidity\":null,\"airUnit\":\"C/%\"");
  }
  Serial.println("}");
}

void setup() {
  Serial.begin(115200);

  pinMode(SENSOR_PIN, INPUT);
  pinMode(PUMP_PIN, OUTPUT);
  dht.begin();

  // يبدأ النظام والمضخة متوقفة.
  setPumpOutput(false, false);

  delay(1000);
  publishReading();
  lastSample = millis();
}

void loop() {
  processPumpCommands();

  unsigned long current = millis();

  // حماية: أوقف المضخة عند انقطاع أوامر التطبيق لمدة 15 ثانية.
  if (pumpOn && current - lastPumpCommand >= PUMP_WATCHDOG_MS) {
    setPumpOutput(false, true);
  }

  // قراءة وإرسال كل ثانية.
  if (current - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = current;
    publishReading();
  }
}
