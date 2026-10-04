import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { ApolloClient, createHttpLink, InMemoryCache } from '@apollo/client/core'
import { DefaultApolloClient } from '@vue/apollo-composable'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import App from './App.vue'
import { router } from './router'
import { apolloClient } from './graphql/client'
import './styles.css'

const vuetify = createVuetify({ components, directives, theme: { defaultTheme: 'light', themes: { light: { colors: { primary: '#315b72', secondary: '#8c6a2f', surface: '#ffffff', background: '#edf1f2' } } } } })
void ApolloClient
void createHttpLink
void InMemoryCache

createApp(App).provide(DefaultApolloClient, apolloClient).use(createPinia()).use(router).use(vuetify).mount('#app')
