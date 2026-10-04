import { ApolloClient, ApolloLink, InMemoryCache, Observable, gql } from '@apollo/client/core'
import { seedSegments } from '../data/seed'

export const TrackSegmentsQuery = gql`
  query TrackSegments {
    segments {
      id
      line
      startMileage
      endMileage
      speedLimit
      version
    }
  }
`

const localGraphLink = new ApolloLink(() => new Observable((observer) => {
  observer.next({ data: { segments: seedSegments } })
  observer.complete()
}))

export const apolloClient = new ApolloClient({
  cache: new InMemoryCache({ typePolicies: { TrackSegment: { keyFields: ['id'] } } }),
  link: localGraphLink
})
