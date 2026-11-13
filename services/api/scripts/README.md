# Realtime Translation Memory demo

Copy `realtime-tm-demo.env.example` to `realtime-tm-demo.env`, fill in the demo API URL, API Gateway key value and ID, a clean tenant ID, table name, and AWS region. Keep the filled file local; do not commit it. The preflight verifies that the API key ID maps to the configured tenant.

From `services/api`, run:

```sh
npm run demo:realtime-tm
```

The script requires AWS credentials with consistent `dynamodb:GetItem` access to the API key mapping and monthly USAGE row, plus `dynamodb:Query` access to the tenant's `TENANT#<tenant>#TM#vi#en` partition. It checks that the key maps to the tenant and that the TM partition is empty before sending traffic. Use a disposable demo tenant and run one copy at a time.

The first pass sends the 600 unique sentences in requests of at most 4,800 characters, then sends the repeated sentence 400 times in separate requests so each call can observe the TM entry created by the earlier pass. The second pass resends the same 1,000 sentences. The script verifies response counters and strongly consistent USAGE counter deltas after each pass.

`MAP_MAX_CONCURRENCY=4` limits concurrent HTTP calls. `TRANSLATE_CONCURRENCY=4` limits parallel TranslateText calls inside each realtime request; the Lambda uses the CloudFormation `TranslateConcurrency` parameter (default 4), while the harness env value documents and reports the expected deployed value. Keep them aligned. HTTP 429 and explicit Translate throttling responses are counted and retried with backoff. Persistent upstream throttling aborts the run so the concurrency can be lowered before rerunning.

This test makes real Amazon Translate calls for the 600 unique sentences on the first pass. Review AWS Budgets before running; the TM records remain in the demo tenant after the test.
