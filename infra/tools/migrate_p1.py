"""Backfill the tenant directory and release slug reservations for legacy pending sites."""

import argparse
import re
from collections import Counter

import boto3
from botocore.exceptions import ClientError

TENANT_ID = re.compile(r"t_[A-Za-z0-9_-]{1,64}")
TENANT_PREFIX = "TENANT#"
SLUG_PREFIX = "TENANT#PLATFORM#SLUG#"
DIRECTORY_PK = "PLATFORM#TENANTS"


def key(pk, sk):
    return {"PK": {"S": pk}, "SK": {"S": sk}}


def string(item, name):
    return item.get(name, {}).get("S", "")


def backfill(client, table, pk, tenant_id):
    client.update_item(
        TableName=table,
        Key=key(pk, "CONFIG"),
        UpdateExpression="SET GSI1PK = :directory, GSI1SK = :tenant",
        ConditionExpression=(
            "attribute_exists(PK) AND (attribute_not_exists(GSI1PK) OR GSI1PK = :directory)"
            " AND (attribute_not_exists(GSI1SK) OR GSI1SK = :tenant)"
        ),
        ExpressionAttributeValues={":directory": {"S": DIRECTORY_PK}, ":tenant": {"S": tenant_id}},
    )


def release_slug(client, table, pk, host_key, tenant_id):
    client.transact_write_items(TransactItems=[
        {"ConditionCheck": {
            "TableName": table,
            "Key": host_key,
            "ConditionExpression": "attribute_not_exists(PK) OR #status = :pending",
            "ExpressionAttributeNames": {"#status": "status"},
            "ExpressionAttributeValues": {":pending": {"S": "PENDING"}},
        }},
        {"Delete": {
            "TableName": table,
            "Key": key(pk, "META"),
            "ConditionExpression": "tenantId = :owner AND attribute_not_exists(verifiedAt)",
            "ExpressionAttributeValues": {":owner": {"S": tenant_id}},
        }},
    ])


def is_condition_race(error):
    code = error.response.get("Error", {}).get("Code")
    reasons = error.response.get("CancellationReasons", [])
    return code == "ConditionalCheckFailedException" or (
        code == "TransactionCanceledException"
        and any(reason.get("Code") == "ConditionalCheckFailed" for reason in reasons)
        and all(reason.get("Code") in {"None", "ConditionalCheckFailed"} for reason in reasons)
    )


def migrate(client, table, apply):
    counts = Counter()
    pages = client.get_paginator("scan").paginate(
        TableName=table,
        ProjectionExpression="PK, SK, tenantId, GSI1PK, GSI1SK, verifiedAt",
        FilterExpression=(
            "(SK = :config AND begins_with(PK, :tenant)) OR "
            "(SK = :meta AND begins_with(PK, :slug) AND attribute_not_exists(verifiedAt))"
        ),
        ExpressionAttributeValues={
            ":config": {"S": "CONFIG"}, ":tenant": {"S": "TENANT#t_"},
            ":meta": {"S": "META"}, ":slug": {"S": SLUG_PREFIX},
        },
    )
    for page in pages:
        for item in page["Items"]:
            pk, sk = string(item, "PK"), string(item, "SK")
            try:
                if sk == "CONFIG":
                    tenant_id = pk.removeprefix(TENANT_PREFIX)
                    if not TENANT_ID.fullmatch(tenant_id):
                        counts["skipped"] += 1
                        continue
                    if string(item, "GSI1PK") == DIRECTORY_PK and string(item, "GSI1SK") == tenant_id:
                        continue
                    counts["directory_candidates"] += 1
                    if apply:
                        backfill(client, table, pk, tenant_id)
                        counts["directory_updated"] += 1
                else:
                    tenant_id = string(item, "tenantId")
                    if not TENANT_ID.fullmatch(tenant_id):
                        counts["skipped"] += 1
                        continue
                    slug = pk.removeprefix(SLUG_PREFIX)
                    host_key = key(f"TENANT#{tenant_id}", f"HOST#{slug}")
                    response = client.get_item(
                        TableName=table, Key=host_key, ConsistentRead=True,
                        ProjectionExpression="#status", ExpressionAttributeNames={"#status": "status"},
                    )
                    host = response.get("Item")
                    if host is not None and string(host, "status") != "PENDING":
                        continue
                    counts["legacy_slug_candidates"] += 1
                    if apply:
                        release_slug(client, table, pk, host_key, tenant_id)
                        counts["legacy_slugs_released"] += 1
            except ClientError as error:
                if not is_condition_race(error):
                    raise
                counts["concurrent_changes"] += 1
    return dict(counts)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--account", required=True, help="Expected AWS account ID")
    cli.add_argument("--region", required=True)
    cli.add_argument("--table", required=True)
    cli.add_argument("--profile")
    cli.add_argument("--apply", action="store_true", help="Write changes. The default only reports candidates.")
    args = cli.parse_args()

    if not re.fullmatch(r"[0-9]{12}", args.account):
        cli.error("--account must be a 12-digit account ID")
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    if session.client("sts").get_caller_identity()["Account"] != args.account:
        cli.error("AWS credentials do not match --account")
    result = migrate(session.client("dynamodb"), args.table, args.apply)
    print(f"{'Applied' if args.apply else 'Dry run'} for {args.table}: {result}")


if __name__ == "__main__":
    main()
