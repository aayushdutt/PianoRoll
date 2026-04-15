import './styles/main.css'
import { App } from './app'

const app = new App()

void app.init().catch(err => {
  console.error('App failed to initialize:', err)
})
