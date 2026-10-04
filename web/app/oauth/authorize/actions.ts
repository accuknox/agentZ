"use server"

import { and, eq, isNull } from "drizzle-orm"
import { getDB, schema } from "@/db"
import { getAuthSession } from "@/lib/auth"
import { delegationCatalog, delegationTransaction } from "@/lib/delegation"
import { approveDelegation } from "@/data/delegations"
import { zDelegationCatalog } from "@/lib/gateway/client/zod.gen"
import type { DelegationCatalog } from "@/lib/gateway/client"

export async function delegationWorkspaceAction(
  oauthQuery: string,
  organizationId: string,
  workspaceId: string
) {
  const session = await getAuthSession()
  if (!session) throw new Error("Sign in to continue.")
  const transaction = await delegationTransaction(
    oauthQuery,
    session.session.user.id,
    session.session.session.id
  )
  if (!transaction)
    throw new Error("This authorization request has expired. Start again from the application.")
  const [membership] = await getDB()
    .select({ id: schema.members.id })
    .from(schema.members)
    .innerJoin(
      schema.organizationDelegation,
      and(
        eq(schema.organizationDelegation.organizationId, schema.members.organizationId),
        eq(schema.organizationDelegation.enabled, true)
      )
    )
    .where(
      and(
        eq(schema.members.organizationId, organizationId),
        eq(schema.members.userId, session.session.user.id),
        isNull(schema.members.disabledAt)
      )
    )
  if (!membership) throw new Error("Resource delegation is unavailable for this organization.")
  return delegationCatalog(organizationId, workspaceId, session.session.user)
}

export async function approveConsentAction(
  oauthQuery: string,
  organizationId: string | null,
  selection: DelegationCatalog
) {
  try {
    await approveDelegation(oauthQuery, organizationId, zDelegationCatalog.parse(selection))
    return { approved: true }
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message || "Access could not be granted. Start again from the application."
          : "Access could not be granted. Start again from the application.",
    }
  }
}
