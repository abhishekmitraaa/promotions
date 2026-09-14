# OTP Verification System Guide

## Overview

The service includes a built-in One-Time Password (OTP) generator and verifier.

- **Security**: Raw OTP codes are NEVER stored in the database. Only an HMAC SHA-256 hash bound to `destination:purpose:code` is persisted.
- **Expiration**: Default 300 seconds (5 minutes), configurable via `OTP_EXPIRY_SECONDS`.
- **Attempt Limits**: Default 5 attempts max, configurable via `OTP_MAX_ATTEMPTS`.
- **Invalidation**: Requesting a new OTP for the same destination & purpose automatically invalidates previous active pending codes.

## Endpoints

- `POST /api/v1/otp/request`: Request an OTP.
- `POST /api/v1/otp/verify`: Verify an OTP.
