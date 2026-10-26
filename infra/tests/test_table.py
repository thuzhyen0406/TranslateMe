import hashlib, time, unicodedata
import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

REGION, TABLE = "ap-southeast-1", "TranslateMe"
session = boto3.Session(profile_name="translateme", region_name=REGION)
ddb = session.resource("dynamodb")
table = ddb.Table(TABLE)
client = ddb.meta.client

T = "t-demo"
MONTH = "2026-10"
SLUG = "homestay-abc"
KEY_ID = "key123"
ttl = int(time.time()) + 7 * 24 * 3600

def sha(text):
    norm = " ".join(unicodedata.normalize("NFC", text).split())
    return hashlib.sha256(norm.encode()).hexdigest()

h = sha("Phòng có ban công nhìn ra sông Hoài.")
now = "2026-10-18T10:00:00Z"

items = {
  "CONFIG": {"PK": f"TENANT#{T}", "SK": "CONFIG", "plan": "Pro", "charLimit": 1000000,
             "status": "ACTIVE", "glossaryVersion": 7},
  "MEMBER": {"PK": f"TENANT#{T}", "SK": "MEMBER#sub-001", "email": "lan@homestay-abc.example",
             "role": "TENANT_ADMIN", "status": "ACTIVE"},
  "GLOSS":  {"PK": f"TENANT#{T}#GLOSS", "SK": "TERM#cao lầu", "type": "FIXED",
             "translations": {"en": "Cao Lau noodles"}, "sinceVersion": 7},
  "TM":     {"PK": f"TENANT#{T}#TM#vi#en#{h[:2]}", "SK": f"HASH#{h}", "src": "Phòng có ban công nhìn ra sông Hoài.",
             "tgt": "The room has a balcony overlooking the Hoai River.", "label": "MACHINE",
             "needsReview": False, "glossaryVersion": 7, "version": 1, "updatedAt": now,
             "GSI3PK": f"TENANT#{T}#TM#en#MACHINE", "GSI3SK": now},
  "SEG":    {"PK": f"TENANT#{T}#SEG#{h}", "SK": "PAGE#en#/phong-nghi/",
             "GSI2PK": f"TENANT#{T}#PAGE#en#/phong-nghi/", "GSI2SK": f"HASH#{h}", "ttl": ttl},
  "USAGE":  {"PK": f"TENANT#{T}#USAGE", "SK": f"MONTH#{MONTH}", "machineChars": 412380, "memoryChars": 286150,
             "requests": 18240, "GSI1PK": f"USAGE#{MONTH}", "GSI1SK": f"TENANT#{T}"},
  "USAGE_WEB": {"PK": f"TENANT#{T}#USAGE", "SK": f"MONTH#{MONTH}#WEB#{SLUG}", "machineChars": 301200},
  "APIKEY": {"PK": f"TENANT#{T}#APIKEY", "SK": f"KEY#{KEY_ID}", "name": "app-mobile-prod",
             "plan": "Standard", "last4": "9F2", "status": "ACTIVE"},
  "KEYUSAGE": {"PK": f"TENANT#{T}#KEYUSAGE#{KEY_ID}", "SK": f"MONTH#{MONTH}", "requests": 18240},
  "JOB":    {"PK": f"TENANT#{T}#JOB", "SK": "JOB#job-20261018-0001", "type": "FILE",
             "status": "QUEUED", "progress": 0, "ttl": ttl},
  "PLATFORM": {"PK": "TENANT#PLATFORM", "SK": "CONFIG", "unitPriceUsdPerMillion": 15,
               "priceDate": "2026-10-08"},
  "KEYMAP": {"PK": f"TENANT#PLATFORM#KEYMAP#{KEY_ID}", "SK": "META", "tenantId": T},
}

# 1) Ghi và đọc từng thực thể
for name, item in items.items():
    table.put_item(Item=item)
    got = table.get_item(Key={"PK": item["PK"], "SK": item["SK"]}).get("Item")
    assert got == item, f"{name}: đọc lại không khớp"
    print(f"OK  {name}")

# 2) Truy vấn 3 GSI
r = table.query(IndexName="GSI2", KeyConditionExpression=Key("GSI2PK").eq(f"TENANT#{T}#PAGE#en#/phong-nghi/"))
assert r["Count"] == 1; print("OK  GSI2 (cau theo trang)")
r = table.query(IndexName="GSI3", KeyConditionExpression=Key("GSI3PK").eq(f"TENANT#{T}#TM#en#MACHINE"))
assert r["Count"] == 1; print("OK  GSI3 (TM theo nhan)")
r = table.query(IndexName="GSI1", KeyConditionExpression=Key("GSI1PK").eq(f"USAGE#{MONTH}"))
assert r["Count"] >= 1; print("OK  GSI1 (so lieu Platform Admin)")

# 3) TransactWriteItems: SLUG có điều kiện attribute_not_exists
def claim_slug(tenant):
    client.transact_write_items(TransactItems=[
      {"Put": {"TableName": TABLE,
               "Item": {"PK": f"TENANT#PLATFORM#SLUG#{SLUG}", "SK": "META", "tenantId": tenant},
               "ConditionExpression": "attribute_not_exists(PK)"}},
      {"Put": {"TableName": TABLE,
               "Item": {"PK": f"TENANT#{tenant}", "SK": f"HOST#{SLUG}", "status": "PENDING"}}},
    ])

# dọn dữ liệu cũ của lần chạy trước để test lặp lại được
table.delete_item(Key={"PK": f"TENANT#PLATFORM#SLUG#{SLUG}", "SK": "META"})
claim_slug(T);               print("OK  SLUG: tenant 1 giữ slug thành công")
try:
    claim_slug("t-other");   print("LOI: tenant 2 không được phép giữ trùng slug")
except ClientError as e:
    codes = [c["Code"] for c in e.response.get("CancellationReasons", [])]
    assert e.response["Error"]["Code"] == "TransactionCanceledException" and "ConditionalCheckFailed" in codes
    print("OK  SLUG: tenant 2 bị chặn", codes)
assert table.get_item(Key={"PK": "TENANT#t-other", "SK": f"HOST#{SLUG}"}).get("Item") is None
print("OK  Giao dịch hoàn tác cả HOST của tenant 2")

# 4) Bản HUMAN không bị MACHINE ghi đè
table.update_item(Key={"PK": items["TM"]["PK"], "SK": items["TM"]["SK"]},
    UpdateExpression="SET #l = :h, tgt = :t", ExpressionAttributeNames={"#l": "label"},
    ExpressionAttributeValues={":h": "HUMAN", ":t": "The room has a balcony facing the Hoai River."})
try:
    table.put_item(Item=items["TM"], ConditionExpression="attribute_not_exists(PK) OR #l <> :h",
        ExpressionAttributeNames={"#l": "label"}, ExpressionAttributeValues={":h": "HUMAN"})
    print("LOI: MACHINE đã ghi đè HUMAN")
except ClientError as e:
    assert e.response["Error"]["Code"] == "ConditionalCheckFailedException"
    print("OK  MACHINE không ghi đè được HUMAN")

# 5) Cộng bộ đếm nguyên tử
table.update_item(Key={"PK": f"TENANT#{T}#USAGE", "SK": f"MONTH#{MONTH}"},
    UpdateExpression="ADD machineChars :n", ExpressionAttributeValues={":n": 100})
print("OK  USAGE: ADD nguyên tử")