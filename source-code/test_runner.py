#!/usr/bin/env python3
"""
ARINC718AForge Pro (v1.0.0) - Automated Test Suite
Verifies core transponder logic, BDS register synthesis, ARINC 429 odd parity, and airworthiness audit.
"""

import unittest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cli = import_module("arinc718a-cli")

class TestARINC718AEngine(unittest.TestCase):

    def test_01_arinc429_odd_parity(self):
        """Test 1: ARINC 429 Bit 32 odd parity generator and validator."""
        # 0x0 has 0 ones -> parity bit must be 1 to make total ones odd (1)
        p0 = cli.calculate_parity(0x00000000)
        self.assertEqual(p0, 1)

        # 0x1 has 1 one -> parity bit must be 0 to keep total ones odd (1)
        p1 = cli.calculate_parity(0x00000001)
        self.assertEqual(p1, 0)

        # 0x3 has 2 ones -> parity bit must be 1 to make total ones odd (3)
        p3 = cli.calculate_parity(0x00000003)
        self.assertEqual(p3, 1)

    def test_02_label_bit_reversal(self):
        """Test 2: Octal label bit reversal to ARINC 429 transmission order."""
        # Label 016 (octal 016 = binary 00001110)
        # Reversed: 01110000 = 0x70
        rev016 = cli.reverse_label_bits(0o016)
        self.assertEqual(rev016, 0x70)

        # Label 203 (octal 203 = binary 10000011)
        # Reversed: 11000001 = 0xC1
        rev203 = cli.reverse_label_bits(0o203)
        self.assertEqual(rev203, 0xC1)

    def test_03_encode_decode_word_integrity(self):
        """Test 3: Encode and decode ARINC 429 32-bit word with parity integrity."""
        word = cli.encode_arinc429_word(0o016, 1, 0x12345, 0x03)
        dec = cli.decode_arinc429_word(word)
        self.assertTrue(dec['parity_valid'])
        self.assertEqual(dec['octal_label'], '0016')
        self.assertEqual(dec['sdi'], 1)
        self.assertEqual(dec['ssm'], 0x03)
        self.assertEqual(dec['ssm_meaning'], 'Normal Operation')

    def test_04_emergency_squawk_detection(self):
        """Test 4: Emergency squawk code detection (7500, 7600, 7700)."""
        self.assertIn('7500', cli.EMERGENCY_SQUAWKS)
        self.assertEqual(cli.EMERGENCY_SQUAWKS['7500']['name'], 'Unlawful Interference / Hijack')
        self.assertIn('7600', cli.EMERGENCY_SQUAWKS)
        self.assertEqual(cli.EMERGENCY_SQUAWKS['7600']['name'], 'Lost Radio Communications')
        self.assertIn('7700', cli.EMERGENCY_SQUAWKS)
        self.assertEqual(cli.EMERGENCY_SQUAWKS['7700']['name'], 'General In-Flight Emergency')
        self.assertNotIn('1200', cli.EMERGENCY_SQUAWKS)

    def test_05_altitude_scaling_label203(self):
        """Test 5: Altitude encoding and BNR bit resolution."""
        alt = 35000
        data_field = alt + 1000
        word = cli.encode_arinc429_word(0o203, 1, data_field, 0x03)
        dec = cli.decode_arinc429_word(word)
        self.assertTrue(dec['parity_valid'])
        recovered_alt = dec['data'] - 1000
        self.assertEqual(recovered_alt, alt)

    def test_06_sign_status_matrix_ssm(self):
        """Test 6: Sign/Status Matrix (SSM) normal operation and failure modes."""
        word_normal = cli.encode_arinc429_word(0o350, 1, 0x00, 0x03)
        dec_normal = cli.decode_arinc429_word(word_normal)
        self.assertEqual(dec_normal['ssm_meaning'], 'Normal Operation')

        word_fail = cli.encode_arinc429_word(0o350, 1, 0x07, 0x00)
        dec_fail = cli.decode_arinc429_word(word_fail)
        self.assertEqual(dec_fail['ssm_meaning'], 'Failure Warning')

    def test_07_sdi_transponder_selection(self):
        """Test 7: Source/Destination Identifier (SDI) XPDR 1 vs XPDR 2."""
        word_xpdr1 = cli.encode_arinc429_word(0o016, 1, 0x100, 0x03)
        word_xpdr2 = cli.encode_arinc429_word(0o016, 2, 0x100, 0x03)
        self.assertEqual(cli.decode_arinc429_word(word_xpdr1)['sdi'], 1)
        self.assertEqual(cli.decode_arinc429_word(word_xpdr2)['sdi'], 2)

    def test_08_hex_formatting_and_width(self):
        """Test 8: ARINC 429 32-bit hex formatting padding."""
        word = cli.encode_arinc429_word(0o016, 0, 0x01, 0x03)
        dec = cli.decode_arinc429_word(word)
        self.assertTrue(dec['word_hex'].startswith('0x'))
        self.assertEqual(len(dec['word_hex']), 10)  # "0x" + 8 hex digits

    def test_09_normative_compliance_audit_rules(self):
        """Test 9: 10-point normative airworthiness compliance audit execution."""
        audit = cli.run_compliance_audit()
        self.assertEqual(audit['total_rules'], 10)
        self.assertEqual(audit['passed_count'], 10)
        self.assertEqual(audit['failed_count'], 0)
        self.assertEqual(audit['score_percent'], 100.0)
        self.assertEqual(audit['certification'], 'ARINC_718A_MODE_S_TSO_C112E_CERTIFIED')

    def test_10_scenario_execution(self):
        """Test 10: Predefined flight simulation scenario validation."""
        try:
            cli.run_scenario('nominal_cruise')
            cli.run_scenario('emergency_hijack')
            cli.run_scenario('tcas_ra_active')
            scenario_ok = True
        except Exception as e:
            scenario_ok = False
        self.assertTrue(scenario_ok)

if __name__ == '__main__':
    unittest.main()
