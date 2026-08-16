import { MqttClient } from './mqtt.mjs'

/**
 * Home Assistant, over MQTT.
 *
 * The point of this plugin is that the music stops being an app you have to
 * open. A wall switch, a voice assistant, an automation that fades the volume
 * when the doorbell rings — all of that is Home Assistant's job, and all it
 * needs from here is a device that publishes its state and listens for
 * commands.
 *
 * **Discovery** is what makes it install itself. Publish one retained JSON
 * document to `homeassistant/media_player/<id>/config` and the entity appears,
 * already wired to the topics named inside it. Nobody edits a YAML file, which
 * is the difference between an integration people use and one they mean to set
 * up one day.
 *
 * Retained is not a detail: it is what makes the entity survive a restart of
 * either side. Home Assistant asks the broker for the retained discovery
 * documents when it starts, so a jukebox that is switched off still has an
 * entity, correctly showing as unavailable.
 */

const DISCOVERY = 'homeassistant'

export function activate(host) {
  const cfg = () => ({
    url: host.config.url || 'mqtt://homeassistant.local:1883',
    username: host.config.username || undefined,
    password: host.config.password || undefined,
    id: host.config.id || 'jukebox',
    name: host.config.name || 'Jukebox',
  })

  const { id, name } = cfg()
  const base = `jukebox/${id}`
  const topics = {
    state: `${base}/state`,
    attributes: `${base}/attributes`,
    availability: `${base}/availability`,
    command: `${base}/command`,
  }

  if (!host.config.url) {
    host.log('no broker configured — set `url` to something like mqtt://homeassistant.local:1883')
    return
  }

  const client = new MqttClient({
    ...cfg(),
    clientId: `jukebox-${id}-${process.pid}`,
    log: host.log,
    // The broker publishes this for us if the connection dies without a
    // goodbye, which is what a crash or a pulled cable looks like. Without it
    // the dashboard shows the last state for ever.
    will: { topic: topics.availability, payload: 'offline' },
  })

  /**
   * The entity, described to Home Assistant.
   *
   * `supported_features` is a bitfield and it has to be honest: claiming
   * `SEEK` when seeking does nothing produces a slider that silently fails,
   * which reads as a broken integration rather than an absent feature.
   */
  const discovery = () => ({
    name,
    unique_id: `jukebox_${id}`,
    // Where the commands go and the state comes from.
    state_topic: topics.state,
    json_attributes_topic: topics.attributes,
    availability_topic: topics.availability,
    command_topic: topics.command,
    payload_available: 'online',
    payload_not_available: 'offline',
    device: {
      identifiers: [`jukebox_${id}`],
      name,
      manufacturer: 'jukebox',
      model: 'Music library',
    },
  })

  const announce = () => {
    client.publish(`${DISCOVERY}/media_player/${id}/config`, JSON.stringify(discovery()), { retain: true })
    client.publish(topics.availability, 'online', { retain: true })
  }

  /**
   * Home Assistant's vocabulary, not this project's.
   *
   * `idle` and `off` are different things to a dashboard: idle is a player
   * waiting with a queue, off is one with nothing in it. Collapsing them makes
   * every automation that checks "is music playing" wrong in one direction or
   * the other.
   */
  const stateOf = (s) => {
    if (!s.trackId) return 'off'
    return s.playing ? 'playing' : 'paused'
  }

  const publish = (s) => {
    if (!client.connected) return
    client.publish(topics.state, stateOf(s), { retain: true })
    client.publish(topics.attributes, JSON.stringify({
      track_id: s.trackId,
      position: s.position,
      queue_length: Array.isArray(s.queue) ? s.queue.length : 0,
      index: s.index,
      repeat: s.repeat,
      shuffle: s.shuffle,
      // Which controller last touched the queue: useful in an automation, and
      // the thing that stops a feedback loop when it was this plugin.
      changed_by: s.by ?? null,
      revision: s.revision,
    }), { retain: true })
  }

  /** The commands Home Assistant sends a media_player. */
  const COMMANDS = {
    play: () => host.player.play('home assistant'),
    pause: () => host.player.pause('home assistant'),
    // A dashboard sends one or the other depending on the card; both exist.
    play_pause: () => (host.player.state().playing
      ? host.player.pause('home assistant')
      : host.player.play('home assistant')),
    stop: () => host.player.pause('home assistant'),
    next: () => host.player.next('home assistant'),
    next_track: () => host.player.next('home assistant'),
    previous: () => host.player.previous('home assistant'),
    previous_track: () => host.player.previous('home assistant'),
    shuffle_on: () => host.player.set({ shuffle: true }, 'home assistant'),
    shuffle_off: () => host.player.set({ shuffle: false }, 'home assistant'),
  }

  client.on(topics.command, (payload) => {
    const command = String(payload).trim().toLowerCase()
    const run = COMMANDS[command]
    if (!run) return host.log(`unknown command: ${command}`)
    try {
      publish(run())
    } catch (err) {
      host.log(`${command} failed: ${err.message}`)
    }
  })

  client.onConnect(() => {
    announce()
    publish(host.player.state())
    host.log(`connected to ${cfg().url} as ${name}`)
  })

  // Every change, including ones this plugin did not cause: the point is that
  // the dashboard agrees with the app when somebody presses pause in either.
  host.on('player', publish)

  client.connect()

  return () => {
    // A deliberate goodbye, so the dashboard shows it as off rather than
    // waiting for the broker to notice the socket is gone.
    try {
      client.publish(topics.availability, 'offline', { retain: true })
    } catch { /* the connection may already be down */ }
    client.close()
  }
}

export function deactivate() {
  // The teardown returned by `activate` is what actually runs; this exists so
  // the host's contract is satisfied either way.
}
