/*
  Smart Plant - Arduino Uno Soil Moisture Sensor + Pump Relay
  الاتصال: USB/Serial بسرعة 115200
  التوصيل الافتراضي: مخرج AO للحساس إلى A0، وريليه المضخة إلى D7

  عدّل DRY_RAW و WET_RAW بعد المعايرة الفعلية للحساس.
  إذا كان الريليه Active-Low فغيّر PUMP_ACTIVE_HIGH إلى false.
  المضخة تتوقف تلقائياً عند انقطاع أوامر التطبيق لمدة PUMP_WATCHDOG_MS.
*/

const byte SENSOR_PIN = A0;
const byte PUMP_PIN = 7;
const bool PUMP_ACTIVE_HIGH = true;
const unsigned long SAMPLE_INTERVAL_MS = 60000UL;
const unsigned long PUMP_WATCHDOG_MS = 15000UL;
const char* DEVICE_ID = "arduino-uno-soil-01";
const char* ZONE_ID = "zone2";

// قيم بداية تقريبية؛ يجب ضبطها من قراءات جهازك.
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
  // أغلب الحساسات التناظرية تعطي قيمة أعلى في التربة الجافة.
  long percent = map(raw, DRY_RAW, WET_RAW, 0, 100);
  return constrain((int)percent, 0, 100);
}

void publishReading() {
  int raw = readRawAverage();
  int moisture = rawToPercent(raw);

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
  Serial.print(",\"unit\":\"percent\",\"calibration\":\"uno-field-calibrated\"}");
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  pinMode(SENSOR_PIN, INPUT);
  pinMode(PUMP_PIN, OUTPUT);
  setPumpOutput(false, false);
  delay(1000);
  publishReading();
  lastSample = millis();
}

void loop() {
  processPumpCommands();
  unsigned long current = millis();
  if (pumpOn && current - lastPumpCommand >= PUMP_WATCHDOG_MS) {
    setPumpOutput(false, true);
  }
  if (current - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = current;
    publishReading();
  }
}
