/*
 * OmniSense Lab — 韌體全域設定（BLE、腳位、協定常數、版本常數）
 * 目前釋出：OMNISENSE_VERSION = 0.4.3（與 web/core/state.js 之 OMNISENSE_WEB_VERSION 須一致）
 * 版本遞增規則：見倉庫 docs/VERSIONING.md
 */
#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// --- BLE 核心設定 (修正編譯歧義與廣播空間) ---
#define SERVICE_UUID           (uint16_t)0xFFE0
#define CHARACTERISTIC_UUID_TX (uint16_t)0xFFE1
#define CHARACTERISTIC_UUID_RX (uint16_t)0xFFE2

#define BLE_DEVICE_NAME "OmniSense_02"

#define OMNISENSE_VER_X   0
#define OMNISENSE_VER_FW  4
#define OMNISENSE_VER_WEB 3

#define OMNISENSE_VERSION    "0.4.3"
#define OMNISENSE_FW_VERSION OMNISENSE_VERSION

/** 與韌體／網頁修訂對應之 16-bit 碼（細節見 docs/VERSIONING.md） */
#define OMNISENSE_VERSION_CODE (((uint16_t)(OMNISENSE_VER_FW) << 8) | (uint16_t)(OMNISENSE_VER_WEB))

/**
 * 類比積分觸控：放電後上拉固定時間再 analogRead（0–4095）；非 ADC 腳位則以上升時間換算為 0–4095。
 */
#define TOUCH_DISCHARGE_US     50u
/** 固定充電時間後再取樣；過短時 ADC 易飽和或雜訊大（可再調） */
#define TOUCH_CHARGE_DWELL_US  28u

// --- 通訊協定常數 (補回遺失定義) ---
#define PACKET_HEADER 0xAA
#define MAX_MTU 247

#define CMD_SET_CONFIG 0x01
#define CMD_CALIBRATE  0x02
#define CMD_REBOOT     0xFF

// --- 腳位與頻道設定 (補回遺失定義) ---
const int ADC_PINS[] = {0, 1, 2, 3, 4};
const int DIGITAL_PINS[] = {8, 9, 20, 21};

const int NUM_ADC_CHANNELS = 5;      // 補回此行
const int NUM_DIGITAL_CHANNELS = 4;  // 補回此行
const int MAX_CHANNELS = 9;

// --- 系統枚舉與結構 ---
enum BitDepth { BIT_8 = 0, BIT_12 = 1, BIT_16 = 2 };

/**
 * activeMask / pullupMask：各 9 通道用 bit0..bit8（與 index.html 邏輯通道一致）
 * pullupMask：1=INPUT_PULLUP，0=INPUT（ESP32-C3 內建弱上拉）
 */
struct SystemConfig {
    uint16_t activeMask;
    uint16_t pullupMask;
    uint16_t sampleRate;
    BitDepth resolution;
    bool isRunning;
    /** bit0..8：觸控模式（16-bit 遮罩；與 activeMask 交集後有效）；payload 為 0–4095 類比積分或計時換算值 */
    uint16_t touchModeMask;
    /** 與 OMNISENSE_VERSION_CODE（y 高八位、z 低八位）一致，僅供除錯／對齊 */
    uint16_t firmwareVersionField;
};

extern SystemConfig g_sysConfig;

#endif