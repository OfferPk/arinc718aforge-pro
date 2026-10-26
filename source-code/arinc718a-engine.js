/**
 * ARINC718AForge Pro (v1.0.0) - Core Transponder Engine
 * Mark 4 Air Traffic Control Transponder (ARINC Characteristic 718A & Mode S / ADS-B Out)
 * 
 * Normative References:
 * - ARINC Characteristic 718A (Mark 4 Air Traffic Control Transponder System)
 * - RTCA DO-181E / EUROCAE ED-73E (MOPS for Air Traffic Control Radar Beacon System/Mode S)
 * - RTCA DO-260B / EUROCAE ED-102A (ADS-B Out Extended Squitter 1090 MHz)
 * - ICAO Annex 10, Volume IV (Surveillance and Collision Avoidance Systems)
 * - FAA TSO-C112e / EASA ETSO-C112c (Air Traffic Control Radar Beacon System/Mode S Airborne Equipment)
 * - ARINC Specification 429 (Mark 33 Digital Information Transfer System)
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ARINC718AEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Constant definitions
  const ARINC429_LABELS = {
    XPDR_CONTROL: 0o016,     // Label 016 - Transponder Control Word
    PRESSURE_ALT: 0o203,     // Label 203 - Selected Altitude / Pressure Altitude
    TCAS_COORD: 0o013,       // Label 013 - TCAS to Transponder Coordination
    TCAS_STATUS: 0o015,      // Label 015 - TCAS Advisory & Status
    MAINT_FAULT: 0o350       // Label 350 - Transponder Fault / Maintenance Word
  };

  const EMERGENCY_SQUAWKS = {
    '7500': { name: 'Unlawful Interference / Hijack', severity: 'CRITICAL', code: 7500 },
    '7600': { name: 'Lost Radio Communications', severity: 'HIGH', code: 7600 },
    '7700': { name: 'General In-Flight Emergency', severity: 'CRITICAL', code: 7700 },
    '7777': { name: 'Military Intercept Operations', severity: 'SPECIAL', code: 7777 }
  };

  const XPDR_MODES = {
    STANDBY: 'STBY',
    ALT_OFF: 'ON (ALT OFF)',
    ALT_ON: 'ALT ON (MODE C/S)',
    TA_ONLY: 'TA ONLY',
    TA_RA: 'TA/RA'
  };

  /**
   * Helper: Calculate ARINC 429 Bit 32 Odd Parity
   */
  function calculateParity(word31Bits) {
    let count = 0;
    for (let i = 0; i < 31; i++) {
      if ((word31Bits >>> i) & 1) {
        count++;
      }
    }
    return (count % 2 === 0) ? 1 : 0;
  }

  /**
   * Helper: Reverse 8-bit octal label to ARINC 429 transmission order
   */
  function reverseLabelBits(octalLabel) {
    let reversed = 0;
    for (let i = 0; i < 8; i++) {
      reversed = (reversed << 1) | ((octalLabel >> i) & 1);
    }
    return reversed;
  }

  /**
   * Helper: Encode a full ARINC 429 32-bit word with Bit 32 Odd Parity
   */
  function encodeARINC429Word(octalLabel, sdi, dataBits, ssm) {
    const revLabel = reverseLabelBits(octalLabel) & 0xFF;
    const sdiField = (sdi & 0x03) << 8;
    const dataField = (dataBits & 0x7FFFF) << 10;
    const ssmField = (ssm & 0x03) << 29;

    let word = revLabel | sdiField | dataField | ssmField;
    const parity = calculateParity(word);
    word |= (parity << 31);
    return word >>> 0;
  }

  /**
   * Helper: Decode an ARINC 429 32-bit word
   */
  function decodeARINC429Word(word32) {
    const parity = (word32 >>> 31) & 1;
    const wordWithoutParity = word32 & 0x7FFFFFFF;
    const expectedParity = calculateParity(wordWithoutParity);
    const parityValid = (parity === expectedParity);

    const ssm = (word32 >>> 29) & 0x03;
    const data = (word32 >>> 10) & 0x7FFFF;
    const sdi = (word32 >>> 8) & 0x03;
    const rawLabel = word32 & 0xFF;
    
    // Reverse label back to standard octal representation
    let octalLabel = 0;
    for (let i = 0; i < 8; i++) {
      octalLabel = (octalLabel << 1) | ((rawLabel >> i) & 1);
    }

    return {
      wordHex: '0x' + word32.toString(16).toUpperCase().padStart(8, '0'),
      octalLabel: '0' + octalLabel.toString(8).padStart(3, '0'),
      sdi,
      data,
      ssm,
      parityValid,
      ssmMeaning: ssm === 0x03 ? 'Normal Operation' : ssm === 0x00 ? 'Failure Warning' : ssm === 0x01 ? 'No Computed Data' : 'Functional Test'
    };
  }

  /**
   * Helper: Encode 6-bit ASCII characters for Mode S BDS registers
   * DO-181E / ICAO Annex 10 character mapping
   */
  function charTo6Bit(ch) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) return code - 64; // A-Z -> 1-26
    if (code >= 48 && code <= 57) return code;      // 0-9 -> 48-57
    if (code === 32) return 32;                     // Space -> 32
    return 32;                                      // Default space
  }

  /**
   * Helper: Decode 6-bit Mode S character to ASCII
   */
  function sixBitToChar(val) {
    if (val >= 1 && val <= 26) return String.fromCharCode(val + 64);
    if (val >= 48 && val <= 57) return String.fromCharCode(val);
    if (val === 32) return ' ';
    return '_';
  }

  /**
   * ARINC 718A Mode S Transponder Line Replaceable Unit (LRU) Class
   */
  class ARINC718ATransponder {
    constructor(config = {}) {
      this.icaoAddress = config.icaoAddress || '8964B1'; // e.g. UAE Boeing 777 / Emirates
      this.flightId = config.flightId || 'UAE123  ';
      this.squawk = config.squawk || '4521';
      this.activeXpdr = config.activeXpdr || 1; // 1 = Captain (XPDR 1), 2 = First Officer (XPDR 2)
      this.mode = config.mode || XPDR_MODES.ALT_ON;
      this.altitude = config.altitude !== undefined ? config.altitude : 35000; // Pressure altitude in ft
      this.flightLevel = Math.round(this.altitude / 100);
      this.airspeed = config.airspeed || 460; // Knots IAS / TAS
      this.groundSpeed = config.groundSpeed || 490; // Knots
      this.mach = config.mach || 0.82;
      this.magneticHeading = config.magneticHeading || 124.5; // Degrees
      this.verticalRate = config.verticalRate || 0; // fpm
      this.rollAngle = config.rollAngle || 0.0; // Degrees
      this.onGround = config.onGround || false; // Weight-on-Wheels
      this.selectedAltitude = config.selectedAltitude || 35000;
      this.baroSetting = config.baroSetting || 1013.25; // hPa
      this.antennaDiversity = config.antennaDiversity || 'TOP_AND_BOTTOM_ACTIVE'; // Diversity status
      this.transmitterHealth = true;
      this.receiverHealth = true;
      this.identActive = false;
      this.identTimer = 0;

      // Comm-B Data Selector (BDS) Registers Matrix
      this.bdsRegisters = {};
      this.updateAllBDSRegisters();
    }

    setSquawk(codeStr) {
      if (!/^[0-7]{4}$/.test(codeStr)) {
        throw new Error(`Invalid octal squawk code: ${codeStr}. Must be exactly 4 octal digits (0-7).`);
      }
      this.squawk = codeStr;
      this.updateAllBDSRegisters();
      return {
        squawk: this.squawk,
        isEmergency: Boolean(EMERGENCY_SQUAWKS[this.squawk]),
        emergencyDetails: EMERGENCY_SQUAWKS[this.squawk] || null
      };
    }

    setAltitude(altFeet) {
      this.altitude = Math.max(-1000, Math.min(65000, Math.round(altFeet)));
      this.flightLevel = Math.round(this.altitude / 100);
      this.updateAllBDSRegisters();
      return this.altitude;
    }

    setMode(mode) {
      if (!Object.values(XPDR_MODES).includes(mode)) {
        throw new Error(`Invalid XPDR Mode: ${mode}`);
      }
      this.mode = mode;
      return this.mode;
    }

    selectTransponder(unit) {
      if (unit !== 1 && unit !== 2) {
        throw new Error('Transponder unit must be 1 or 2');
      }
      this.activeXpdr = unit;
      return this.activeXpdr;
    }

    triggerIdent(durationSeconds = 18) {
      this.identActive = true;
      this.identTimer = durationSeconds;
      return { identActive: true, duration: durationSeconds };
    }

    /**
     * Synthesize BDS 0,8 / BDS 2,0: Aircraft Identification (Callsign)
     * 56-bit Comm-B register: 8 characters * 6 bits = 48 bits + 8 bits reserved
     */
    buildBDS20() {
      const paddedId = (this.flightId + '        ').slice(0, 8).toUpperCase();
      let hexString = '';
      let bitBuffer = 0n;
      let bitsInBuf = 0;

      for (let i = 0; i < 8; i++) {
        const val = BigInt(charTo6Bit(paddedId[i]));
        bitBuffer = (bitBuffer << 6n) | val;
        bitsInBuf += 6;
      }
      // Pad to 56 bits
      bitBuffer = bitBuffer << 8n;
      hexString = bitBuffer.toString(16).toUpperCase().padStart(14, '0');
      
      this.bdsRegisters['BDS_2_0'] = {
        name: 'Aircraft Identification (Flight ID)',
        bdsCode: '2,0',
        hexValue: hexString,
        decoded: paddedId.trim(),
        bits: 56
      };
      return this.bdsRegisters['BDS_2_0'];
    }

    /**
     * Synthesize BDS 1,0: Data Link Capability Report
     * 56-bit Comm-B register describing transponder level, Mode S subnetwork, antenna diversity
     */
    buildBDS10() {
      // Bit 1-8: BDS 1,0 code
      // Bit 9: Continuation flag
      // Bit 10-15: Mode S Subnetwork version (e.g. 5)
      // Bit 16: Transponder Level (Level 4/5)
      // Bit 17: Antenna diversity capability (1 = Diversity)
      // Bit 18-24: Comm-B delivery capabilities
      let bitVal = 0x10000000000000n; // Level 4 Transponder
      bitVal |= (0x05n << 40n);       // Subnetwork v5
      bitVal |= (0x01n << 39n);       // Diversity operational
      bitVal |= (0x01n << 38n);       // 1090 MHz Extended Squitter capable
      bitVal |= (0x01n << 37n);       // ACAS / TCAS cross-link active
      bitVal |= (0x01n << 24n);       // Enhanced Surveillance (EHS) capable

      const hexString = bitVal.toString(16).toUpperCase().padStart(14, '0');
      this.bdsRegisters['BDS_1_0'] = {
        name: 'Data Link Capability Report',
        bdsCode: '1,0',
        hexValue: hexString,
        level: 'Level 4 Mark 4 Transponder',
        diversity: true,
        ehsCapable: true,
        bits: 56
      };
      return this.bdsRegisters['BDS_1_0'];
    }

    /**
     * Synthesize BDS 4,0: Selected Vertical Intent
     * Ingests MCP/FCU Selected Altitude, FMS Selected Altitude, and Baro Setting
     */
    buildBDS40() {
      // Bit 1: MCP/FCU status bit
      // Bit 2-13: MCP/FCU Selected Altitude (16 ft resolution)
      // Bit 14: FMS status bit
      // Bit 15-26: FMS Selected Altitude (16 ft resolution)
      // Bit 27: Baro pressure setting status bit
      // Bit 28-39: Baro Setting (0.1 mb/hPa resolution, offset 800 mb)
      const mcpVal = BigInt(Math.max(0, Math.min(65520, Math.round(this.selectedAltitude / 16)))) & 0xFFFn;
      const baroVal = BigInt(Math.max(0, Math.min(4095, Math.round((this.baroSetting - 800) * 10)))) & 0xFFFn;
      
      let bitVal = (1n << 55n);                // MCP Status Active
      bitVal |= (mcpVal << 43n);               // MCP Altitude
      bitVal |= (1n << 42n);                   // FMS Status Active
      bitVal |= (mcpVal << 30n);               // FMS Altitude
      bitVal |= (1n << 29n);                   // Baro Status Active
      bitVal |= (baroVal << 17n);              // Barometric Setting
      bitVal |= (0x01n << 8n);                 // Mode bits

      const hexString = bitVal.toString(16).toUpperCase().padStart(14, '0');
      this.bdsRegisters['BDS_4_0'] = {
        name: 'Selected Vertical Intent',
        bdsCode: '4,0',
        hexValue: hexString,
        mcpAltitude: this.selectedAltitude,
        baroSettingHpa: this.baroSetting,
        bits: 56
      };
      return this.bdsRegisters['BDS_4_0'];
    }

    /**
     * Synthesize BDS 5,0: Track and Turn Report
     * Ingests Roll Angle, True Track Angle, Ground Speed, Track Angle Rate
     */
    buildBDS50() {
      // Roll angle resolution: 45/256 deg (~0.176 deg)
      const rollUnits = BigInt(Math.max(-256, Math.min(255, Math.round(this.rollAngle / (45.0 / 256.0))))) & 0x1FFn;
      // True Track Angle resolution: 360/1024 deg (~0.35 deg)
      const trackUnits = BigInt(Math.max(0, Math.min(1023, Math.round(this.magneticHeading / (360.0 / 1024.0))))) & 0x3FFn;
      // Ground Speed resolution: 1024/512 = 2 kt
      const gsUnits = BigInt(Math.max(0, Math.min(1023, Math.round(this.groundSpeed / 2)))) & 0x3FFn;

      let bitVal = (1n << 55n);          // Roll Status Active
      bitVal |= (rollUnits << 46n);      // Roll Angle
      bitVal |= (1n << 45n);             // True Track Status Active
      bitVal |= (trackUnits << 35n);     // True Track Angle
      bitVal |= (1n << 34n);             // Ground Speed Status Active
      bitVal |= (gsUnits << 24n);        // Ground Speed

      const hexString = bitVal.toString(16).toUpperCase().padStart(14, '0');
      this.bdsRegisters['BDS_5_0'] = {
        name: 'Track and Turn Report',
        bdsCode: '5,0',
        hexValue: hexString,
        rollAngle: this.rollAngle,
        groundSpeed: this.groundSpeed,
        bits: 56
      };
      return this.bdsRegisters['BDS_5_0'];
    }

    /**
     * Synthesize BDS 6,0: Heading and Speed Report
     * Ingests Magnetic Heading, Indicated Airspeed, Mach, Baro Altitude Rate
     */
    buildBDS60() {
      // Magnetic Heading: 360/1024 (~0.35 deg)
      const hdgUnits = BigInt(Math.max(0, Math.min(1023, Math.round(this.magneticHeading / (360.0 / 1024.0))))) & 0x3FFn;
      // IAS: 1 kt resolution
      const iasUnits = BigInt(Math.max(0, Math.min(1023, Math.round(this.airspeed)))) & 0x3FFn;
      // Mach: 0.008 resolution
      const machUnits = BigInt(Math.max(0, Math.min(511, Math.round(this.mach / 0.008)))) & 0x1FFn;
      // Baro Rate: 32 fpm resolution
      const rateUnits = BigInt(Math.max(-256, Math.min(255, Math.round(this.verticalRate / 32)))) & 0x1FFn;

      let bitVal = (1n << 55n);          // Heading Status Active
      bitVal |= (hdgUnits << 45n);       // Magnetic Heading
      bitVal |= (1n << 44n);             // Airspeed Status Active
      bitVal |= (iasUnits << 34n);       // IAS
      bitVal |= (1n << 33n);             // Mach Status Active
      bitVal |= (machUnits << 24n);      // Mach
      bitVal |= (1n << 23n);             // Baro Rate Status Active
      bitVal |= (rateUnits << 14n);      // Barometric Altitude Rate

      const hexString = bitVal.toString(16).toUpperCase().padStart(14, '0');
      this.bdsRegisters['BDS_6_0'] = {
        name: 'Heading and Speed Report',
        bdsCode: '6,0',
        hexValue: hexString,
        magneticHeading: this.magneticHeading,
        ias: this.airspeed,
        mach: this.mach,
        verticalRate: this.verticalRate,
        bits: 56
      };
      return this.bdsRegisters['BDS_6_0'];
    }

    /**
     * Synthesize BDS 3,0: ACAS Active Resolution Advisory (RA)
     */
    buildBDS30() {
      // 56-bit register indicating active RA sense and complement
      let bitVal = 0x00000000000000n;
      if (this.mode === XPDR_MODES.TA_RA) {
        bitVal |= (0x01n << 48n); // ACAS Active
        bitVal |= (0x01n << 40n); // Threat tracking normal
      }
      const hexString = bitVal.toString(16).toUpperCase().padStart(14, '0');
      this.bdsRegisters['BDS_3_0'] = {
        name: 'ACAS Active Resolution Advisory (RA)',
        bdsCode: '3,0',
        hexValue: hexString,
        raActive: this.mode === XPDR_MODES.TA_RA,
        bits: 56
      };
      return this.bdsRegisters['BDS_3_0'];
    }

    updateAllBDSRegisters() {
      this.buildBDS10();
      this.buildBDS20();
      this.buildBDS30();
      this.buildBDS40();
      this.buildBDS50();
      this.buildBDS60();
      return this.bdsRegisters;
    }

    /**
     * Encode ARINC 429 Label 016 (Transponder Control Word)
     * Transmitted by Cockpit Control Panel to Transponder LRU
     */
    encodeLabel016() {
      // Octal Squawk Code: 4 digits in BCD (12 bits: Bits 11-22)
      const d1 = parseInt(this.squawk[0], 8) & 0x07;
      const d2 = parseInt(this.squawk[1], 8) & 0x07;
      const d3 = parseInt(this.squawk[2], 8) & 0x07;
      const d4 = parseInt(this.squawk[3], 8) & 0x07;
      const bcdSquawk = (d1 << 9) | (d2 << 6) | (d3 << 3) | d4;

      // Mode Bits (Bits 23-25): 0=STBY, 1=ALT OFF, 2=ALT ON, 3=TA ONLY, 4=TA/RA
      let modeBits = 2; // Default ALT ON
      if (this.mode === XPDR_MODES.STANDBY) modeBits = 0;
      else if (this.mode === XPDR_MODES.ALT_OFF) modeBits = 1;
      else if (this.mode === XPDR_MODES.ALT_ON) modeBits = 2;
      else if (this.mode === XPDR_MODES.TA_ONLY) modeBits = 3;
      else if (this.mode === XPDR_MODES.TA_RA) modeBits = 4;

      // XPDR Select (Bit 26): 0 = XPDR 1, 1 = XPDR 2
      const xpdrSelect = (this.activeXpdr === 2) ? 1 : 0;
      // Altitude Source (Bit 27): 0 = ADIRU 1, 1 = ADIRU 2
      const adiruSource = (this.activeXpdr === 2) ? 1 : 0;
      // Ident active (Bit 28)
      const identBit = this.identActive ? 1 : 0;

      const dataField = (bcdSquawk) | (modeBits << 12) | (xpdrSelect << 15) | (adiruSource << 16) | (identBit << 17);
      const sdi = (this.activeXpdr === 2) ? 2 : 1;
      const ssm = 0x03; // Normal Operation

      return encodeARINC429Word(ARINC429_LABELS.XPDR_CONTROL, sdi, dataField, ssm);
    }

    /**
     * Encode ARINC 429 Label 203 (Pressure Altitude)
     * Ingested from ADIRU (Resolution 1 ft BNR)
     */
    encodeLabel203() {
      // 17-bit two's complement or unsigned BNR altitude
      // Scale: 1 bit = 1 ft, range -1000 to +65535 ft
      const altData = (this.altitude + 1000) & 0x1FFFF;
      const sdi = (this.activeXpdr === 2) ? 2 : 1;
      const ssm = 0x03; // Normal Operation
      return encodeARINC429Word(ARINC429_LABELS.PRESSURE_ALT, sdi, altData, ssm);
    }

    /**
     * Encode ARINC 429 Label 350 (Transponder Maintenance / Fault Word)
     */
    encodeLabel350() {
      let faultBits = 0;
      if (!this.transmitterHealth) faultBits |= (1 << 0);
      if (!this.receiverHealth) faultBits |= (1 << 1);
      if (this.antennaDiversity === 'FAIL') faultBits |= (1 << 2);
      
      const sdi = (this.activeXpdr === 2) ? 2 : 1;
      const ssm = (faultBits === 0) ? 0x03 : 0x00; // 03 = Normal, 00 = Failure
      return encodeARINC429Word(ARINC429_LABELS.MAINT_FAULT, sdi, faultBits, ssm);
    }

    /**
     * Get Complete Transponder Telemetry Snapshot
     */
    getTelemetrySnapshot() {
      const label016Word = this.encodeLabel016();
      const label203Word = this.encodeLabel203();
      const label350Word = this.encodeLabel350();

      return {
        timestamp: new Date().toISOString(),
        icaoAddress: this.icaoAddress,
        flightId: this.flightId.trim(),
        activeTransponder: `XPDR ${this.activeXpdr} (${this.activeXpdr === 1 ? 'Captain' : 'First Officer'})`,
        mode: this.mode,
        squawk: this.squawk,
        isEmergency: Boolean(EMERGENCY_SQUAWKS[this.squawk]),
        emergencyDetails: EMERGENCY_SQUAWKS[this.squawk] || null,
        altitudeFt: this.altitude,
        flightLevel: `FL${this.flightLevel.toString().padStart(3, '0')}`,
        airspeedKt: this.airspeed,
        groundSpeedKt: this.groundSpeed,
        mach: this.mach.toFixed(2),
        magneticHeadingDeg: this.magneticHeading.toFixed(1),
        verticalRateFpm: this.verticalRate,
        weightOnWheels: this.onGround ? 'AIRFRAME ON GROUND' : 'AIRBORNE',
        antennaDiversity: this.antennaDiversity,
        arinc429Words: {
          label016_Control: decodeARINC429Word(label016Word),
          label203_Altitude: decodeARINC429Word(label203Word),
          label350_Maintenance: decodeARINC429Word(label350Word)
        },
        bdsRegisters: this.bdsRegisters
      };
    }
  }

  return {
    ARINC718ATransponder,
    ARINC429_LABELS,
    EMERGENCY_SQUAWKS,
    XPDR_MODES,
    calculateParity,
    reverseLabelBits,
    encodeARINC429Word,
    decodeARINC429Word,
    charTo6Bit,
    sixBitToChar
  };
}));
