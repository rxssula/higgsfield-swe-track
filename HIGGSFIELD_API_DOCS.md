> ## Documentation Index
>
> Fetch the complete documentation index at: https://docs.higgsfield.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# How to use API

> Complete guide to using the Higgsfield API

## Overview

The Model endpoint is the primary entry point for generating content with the Higgsfield API. Each model on the Higgsfield platform has a unique `model_id` (e.g., `higgsfield-ai/soul/standard`).

**Base API URL:** `https://platform.higgsfield.ai`

The Higgsfield API uses an asynchronous request-response pattern. When you submit a generation request, it enters a queue and processes in the background. This approach offers several advantages:

- Monitor task status without maintaining open connections
- Cancel requests that haven't started processing
- Avoid resource-intensive concurrent connections

## API Endpoints

### Queue Management

| Endpoint                                                      | Method | Description                                 |
| ------------------------------------------------------------- | ------ | ------------------------------------------- |
| `https://platform.higgsfield.ai/{model_id}`                   | POST   | Submit a generation request to the queue    |
| `https://platform.higgsfield.ai/requests/{request_id}/status` | GET    | Retrieve the status of a generation request |
| `https://platform.higgsfield.ai/requests/{request_id}/cancel` | POST   | Cancel a pending request                    |

### Parameters

- **`model_id`**: The unique identifier for the model (e.g., `higgsfield-ai/soul/standard`)
- **`request_id`**: A unique UUID assigned to your request upon submission

## Usage Examples

### Submitting a Generation Request

```bash theme={null}
curl -X POST 'https://platform.higgsfield.ai/higgsfield-ai/soul/standard' \
  --header 'Authorization: Key {your_api_key}:{your_api_key_secret}' \
  --data '{
    "prompt": "your prompt here",
    "aspect_ratio": "16:9",
    "resolution": "720p"
  }'
```

### Response Format

#### Queued Request

```json theme={null}
{
    "status": "queued",
    "request_id": "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff",
    "status_url": "https://platform.higgsfield.ai/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/status",
    "cancel_url": "https://platform.higgsfield.ai/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/cancel"
}
```

#### Completed Request

```json theme={null}
{
    "status": "completed",
    "request_id": "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff",
    "status_url": "https://platform.higgsfield.ai/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/status",
    "cancel_url": "https://platform.higgsfield.ai/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/cancel",
    "images": [
        {
            "url": "https://image.url/example.jpg"
        }
    ],
    "video": {
        "url": "https://video.url/example.mp4"
    }
}
```

## Request Statuses

| Status        | Description                                                     |
| ------------- | --------------------------------------------------------------- |
| `queued`      | Request is waiting in the queue and has not started processing  |
| `in_progress` | Generation is actively processing (cancellation not available)  |
| `nsfw`        | Content failed moderation checks (credits refunded)             |
| `failed`      | Generation encountered an error (credits refunded)              |
| `completed`   | Generation finished successfully (media available for download) |

## Canceling a Request

You can cancel a request only while it remains in the `queued` status. Once processing begins, cancellation is no longer possible.

```bash theme={null}
curl -X POST https://platform.higgsfield.ai/requests/{request_id}/cancel \
  --header 'Authorization: Key {your_api_key}:{your_api_key_secret}'
```

If cancellation was successful, you will get a `202 Accepted` response status code. Otherwise, response status code will be `400 Bad Request`.

## Best Practices

- Poll the status endpoint periodically to check request progress
- Or use webhooks to get generation result by HTTP
- Store the `request_id` to retrieve results later
- Handle different status codes appropriately in your application

Built with [Mintlify](https://mintlify.com).
