# Architecture

This project is organized around a small set of cloud functions that separate AI generation, result authorization, quota control, mock payment, and PDF access.

## System Flow

```mermaid
sequenceDiagram
  participant U as User
  participant MP as Mini Program
  participant OR as optimizeResume
  participant AI as DeepSeek API
  participant DB as Cloud Database
  participant FS as Cloud Storage

  U->>MP: Submit resume text / PDF / profile
  MP->>OR: callFunction optimizeResume
  OR->>DB: Check free/pro quota by openid
  OR->>AI: Generate structured resume JSON
  OR->>FS: Upload generated PDF
  OR->>DB: Save full result and free result
  OR-->>MP: Return resultId and free preview
```

## Unlock Flow

```mermaid
sequenceDiagram
  participant U as User
  participant MP as Mini Program
  participant CO as createOrder
  participant DB as Cloud Database
  participant GR as getResult

  U->>MP: Tap unlock
  MP->>CO: createOrder(resultId)
  CO->>DB: Validate owner and create order
  alt ENABLE_MOCK_PAY=true
    CO->>DB: Mark paid, unlock result, add credits
    CO-->>MP: mockPaid
  else Real payment
    CO-->>MP: payment params
    MP->>MP: wx.requestPayment
  end
  MP->>GR: getResult(resultId)
  GR->>DB: Validate openid and unlock status
  GR-->>MP: Return full resume if unlocked
```

## Cloud Functions

- `optimizeResume`: validates quota, calls AI, generates PDF, saves result.
- `getResult`: returns free or unlocked result according to openid.
- `getQuota`: returns free and professional analysis quota.
- `getPdfUrl`: validates ownership and unlock status before returning a temporary PDF URL.
- `createOrder`: creates an unlock order and supports mock payment.
- `payNotify`: handles real payment notification and unlocks entitlement.
- `deleteResult`: deletes cloud result and generated PDF after ownership validation.

## Data Collections

```text
users
resume_results
orders
entitlements
```

The front end should never rely on local state for authorization. Full resume text and PDF access are always checked by cloud functions with the current user's `openid`.

