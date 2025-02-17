import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import { Query, CollectionReference } from 'firebase-admin/firestore'
import { uniq } from 'lodash'

import { invokeFunction, loadPaginated } from 'shared/utils'
import { newEndpointNoAuth } from '../api/helpers'
import { getMarketRecommendations } from 'common/recommendation'
import { run } from 'common/supabase/utils'
import { mapAsyncChunked } from 'common/util/promise'
import { createSupabaseClient } from 'shared/supabase/init'
import { filterDefined } from 'common/util/array'
import { Contract } from 'common/contract'

const firestore = admin.firestore()

export const scheduleUpdateRecommended = functions.pubsub
  // Run every hour.
  .schedule('0 * * * *')
  .timeZone('America/Los_Angeles')
  .onRun(async () => {
    try {
      console.log(await invokeFunction('updaterecommended'))
    } catch (e) {
      console.error(e)
    }
  })

export const updaterecommended = newEndpointNoAuth(
  { timeoutSeconds: 3600, memory: '8GiB', minInstances: 0 },
  async (_req) => {
    await updateRecommendedMarkets()
    return { success: true }
  }
)

export const updateRecommendedMarkets = async () => {
  console.log('Loading contracts...')
  const contracts = await loadContracts()

  console.log('Loading user data...')
  const userData = await loadUserDataForRecommendations()

  console.log('Computing recommendations...')

  const { userIds, userFeatures, contractIds, contractFeatures } =
    getMarketRecommendations(contracts, userData, 2500)

  const userFeatureRows = userFeatures.map((features, i) => ({
    user_id: userIds[i],
    f0: features[0],
    f1: features[1],
    f2: features[2],
    f3: features[3],
    f4: features[4],
  }))
  const contractFeatureRows = contractFeatures.map((features, i) => ({
    contract_id: contractIds[i],
    f0: features[0],
    f1: features[1],
    f2: features[2],
    f3: features[3],
    f4: features[4],
  }))

  console.log('Writing recommendations to Supabase...')

  const db = createSupabaseClient()
  await run(db.from('user_recommendation_features').upsert(userFeatureRows))
  await run(
    db.from('contract_recommendation_features').upsert(contractFeatureRows)
  )

  console.log('Done.')
}

export const loadUserDataForRecommendations = async () => {
  const userIds = (
    await loadPaginated(
      firestore.collection('users').select('id') as Query<{ id: string }>
    )
  ).map(({ id }) => id)

  console.log('Loaded', userIds.length, 'users')

  return await mapAsyncChunked(
    userIds,
    async (userId) => {
      const betOnIds = (
        await loadPaginated(
          firestore
            .collection('users')
            .doc(userId)
            .collection('contract-metrics')
            .select('contractId') as Query<{ contractId: string }>
        )
      ).map(({ contractId }) => contractId)

      const swipeData = await loadPaginated(
        admin
          .firestore()
          .collection('private-users')
          .doc(userId)
          .collection('seenMarkets')
          .select('id') as Query<{ id: string }>
      )
      const swipedIds = uniq(swipeData.map(({ id }) => id))

      const viewedCardIds = uniq(
        (
          await loadPaginated(
            firestore
              .collection('users')
              .doc(userId)
              .collection('events')
              .where('name', '==', 'view market card')
              .select('contractId') as Query<{ contractId: string }>
          )
        ).map(({ contractId }) => contractId)
      )

      const viewedPageIds = uniq(
        (
          await loadPaginated(
            firestore
              .collection('users')
              .doc(userId)
              .collection('events')
              .where('name', '==', 'view market')
              .select('contractId') as Query<{ contractId: string }>
          )
        ).map(({ contractId }) => contractId)
      )

      const likedIds = uniq(
        (
          await loadPaginated(
            admin
              .firestore()
              .collection('users')
              .doc(userId)
              .collection('reactions')
              .where('contentType', '==', 'contract')
              .select('contentId') as Query<{ contentId: string }>
          )
        ).map(({ contentId }) => contentId)
      )

      const groupMemberSnap = await admin
        .firestore()
        .collectionGroup('groupMembers')
        .where('userId', '==', userId)
        .select()
        .get()
      const groupIds = uniq(
        filterDefined(
          groupMemberSnap.docs.map((doc) => doc.ref.parent.parent?.id)
        )
      )
      return {
        userId,
        betOnIds,
        swipedIds,
        viewedCardIds,
        viewedPageIds,
        likedIds,
        groupIds,
      }
    },
    10
  )
}

export const loadContracts = async () => {
  const contracts = await loadPaginated(
    firestore.collection('contracts') as CollectionReference<Contract>
  )
  console.log('Loaded', contracts.length, 'contracts')
  return contracts
}
