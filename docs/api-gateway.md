# Module REST API của API Gateway

`infra/modules/api-gateway.yaml` định nghĩa cổng vào REST API dưới dạng một
module CloudFormation độc lập:

- `/console` và `/console/*` sử dụng authorizer Cognito User Pool. Cung cấp
  `CognitoUserPoolId` từ TV4; module này không tạo hoặc sở hữu User Pool.
- `/translate` và `/translate/*` yêu cầu API key. Cả đường dẫn proxy chính xác
  và proxy greedy đều được định nghĩa; mỗi route gọi Lambda đã cấu hình.
- API Gateway gọi hai hàm Lambda đã cấu hình thông qua các quyền Lambda có phạm
  vi giới hạn chặt chẽ.
- `BasicUsagePlan` và `StandardUsagePlan` được gắn với stage đã triển khai. Tạo
  API key riêng và liên kết từng key với plan phù hợp.
- Các lỗi do Gateway tạo ra sử dụng các trường JSON `code` và `request_id`:
  `UNAUTHORIZED`/401 khi Cognito từ chối hoặc API key bị thiếu/không hợp lệ,
  `RATE_LIMITED`/429 khi bị giới hạn tốc độ, và `REQUEST_QUOTA_EXCEEDED`/429 khi
  vượt quota của usage plan.

## Giá trị mặc định ví dụ của usage plan

Hiện repository không có Table 1.3 được đề cập. Các giá trị mặc định của tham số
này **chỉ mang tính minh họa**, được tính bằng số request (không phải số ký tự
được dịch), và cần được đối chiếu với quota tài khoản thực tế của TV1 cùng
Table 1.3 đã thống nhất trước khi triển khai:

| Plan | Tốc độ (request/giây) | Burst | Quota (request/tháng) |
| --- | ---: | ---: | ---: |
| Basic | 2 | 4 | 5,000 |
| Standard | 10 | 20 | 50,000 |

Truyền sáu tham số `Basic*` và `Standard*` khi triển khai để ghi đè các giá trị
ví dụ này. Giới hạn tốc độ và quota của usage plan trong API Gateway là các biện
pháp kiểm soát theo nỗ lực tối đa, không phải giới hạn cứng; chúng không nên thay
thế việc áp dụng quota nghiệp vụ hoặc thanh toán ở phía ứng dụng.

## Triển khai và smoke test

Khi triển khai template này, truyền User Pool ID từ TV4 và ARN Lambda của các
handler console và translate. Các bản triển khai API Gateway là snapshot bất
biến: khi method hoặc integration thay đổi, hãy thêm logical ID mới cho tài
nguyên deployment (ví dụ: `ApiDeploymentV2`) và cập nhật `ApiStage.DeploymentId`
để tham chiếu đến ID đó. Chỉ thay đổi `Description` của deployment sẽ không
phát hành API đã cập nhật. Sau khi triển khai, liên kết các API key đã cấp với
`BasicUsagePlanId` hoặc `StandardUsagePlanId`.

Kiểm tra route dịch mà không có key; route này sẽ trả về HTTP 401 với JSON có
`code` là `UNAUTHORIZED` và có `request_id`:

```sh
curl -i "$API_BASE_URL/translate/health"
```

Với key hợp lệ, gửi số request vượt quá tốc độ/burst của plan đã chọn để kiểm tra
phản hồi HTTP 429 có `RATE_LIMITED`:

```sh
for i in $(seq 1 30); do
  curl -sS -i -H "x-api-key: $API_KEY" "$API_BASE_URL/translate/health" &
done
wait
```

Để kiểm tra `REQUEST_QUOTA_EXCEEDED`, hãy dùng một test plan ngắn hạn có quota
hàng tháng thấp và sử dụng hết quota đó. Việc giới hạn tốc độ và áp dụng quota
có thể không diễn ra ngay lập tức vì giới hạn usage plan chỉ được đảm bảo theo
nỗ lực tối đa.
