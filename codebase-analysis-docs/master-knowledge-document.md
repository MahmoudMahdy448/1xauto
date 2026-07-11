# Master Knowledge Document

## 1. System Overview

### Purpose
This repository contains a Playwright-based browser automation flow for signing into a 1xBet account and navigating to the deposit/recharge flow. The script is designed for interactive use with a visible browser so the operator can complete CAPTCHA, OTP, or other verification steps manually when required.

### Stack and Runtime
- Node.js 20+
- Playwright Test
- JavaScript (ES modules)
- dotenv for local environment loading

### High-Level Architecture Diagram
```text
User / Operator
  |
  v
Playwright Test Runner
  |
  v
Browser Automation Flow
  |-- Open 1xBet login page
  |-- Fill credentials
  |-- Handle optional account verification
  |-- Open recharge/deposit page
  |-- Interact with embedded payment iframe
  |-- Capture a screenshot of the payment window
  |
  v
External Website: 1xBet / Vodafone deposit flow
```

## 2. Folder Structure Map

```text
1xbet-auto/
├── .agents/                  # Local agent or automation metadata (if present)
├── .env                      # Local secrets, ignored by Git
├── .env.example              # Template for required credentials
├── .gitignore                # Ignore rules for local artifacts
├── node_modules/             # Installed dependencies
├── package.json              # Project metadata and scripts
├── package-lock.json         # Lockfile for npm dependencies
├── playwright.config.js      # Playwright runner configuration
├── README.md                 # Setup and usage instructions
├── screenshots/              # Captured deposit screenshots
├── test-results/             # Playwright test artifacts
└── tests/
    └── login.spec.js        # Main browser automation test
```

## 3. Core Features & Domains

### Primary Domain: Automated Login and Deposit Flow
The core feature is implemented in [tests/login.spec.js](../tests/login.spec.js). The test performs the following steps:

1. Reads credentials from environment variables or a local .env file.
2. Opens the 1xBet login page.
3. Fills username and password fields.
4. Submits the login form.
5. Detects and handles an account verification page when the site requests a surname confirmation.
6. Navigates to the recharge page.
7. Interacts with an embedded payment iframe, selects the Vodafone deposit option, and captures a screenshot of the payment modal.

### Important Implementation Notes
- The automation is intentionally non-opaque: it relies on a visible browser and does not attempt to bypass security or verification controls.
- The test exits after capturing the payment window screenshot rather than completing a payment transaction.
- The flow uses Playwright locators such as ID selectors and role-based selectors to find form elements and modal UI.

## 4. Tech Stack & Integrations

### Runtime and Test Framework
- Node.js
- Playwright Test
- dotenv

### External Interfaces
- 1xBet website login and account verification pages
- 1xBet recharge/deposit area
- Embedded payment iframe for the Vodafone deposit flow

### Environment Variables
The repository expects these variables:
- ONEXBET_USERNAME
- ONEXBET_PASSWORD
- ONEXBET_SURNAME

These are defined in [./.env.example](../.env.example).

## 5. Architectural Weaknesses (Tech Debt)

### Immediate Concerns
- The project is tightly coupled to a single website flow and a specific UI structure, so any website changes can break the automation.
- The automation contains hard-coded URLs and selectors, which makes maintenance more fragile.
- The single test file mixes navigation, verification handling, iframe interaction, and screenshot capture into one flow; splitting it into helpers or page-object abstractions would improve maintainability.
- There is no explicit test data abstraction beyond environment variables, and no retry or fallback strategy for flaky UI conditions.

### Reliability and Security Notes
- Credentials are loaded from local environment variables, which is reasonable for a personal automation workflow, but there is no secret-management layer beyond .env.
- The flow relies on a visible browser and manual CAPTCHA/OTP handling, which is appropriate but should be documented clearly for operators.

## 6. AI Setup Guide

### Coding Conventions
- Keep changes small and focused on the automation flow.
- Prefer Playwright locator APIs over brittle manual DOM traversal.
- Preserve the current ES module style in JavaScript files.

### Validation Workflow
- Install dependencies with npm install.
- Install the browser with npx playwright install chromium.
- Configure credentials in .env using .env.example as the template.
- Run the flow with npm run login.

### Formatting and Style Guidance
- Follow the existing JavaScript style in the repository: simple, explicit, and readable.
- Avoid introducing extra frameworks or dependencies unless there is a clear need.
- Keep test names descriptive and user-facing.
