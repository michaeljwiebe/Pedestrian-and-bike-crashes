const keys = require('./keys.js')
const representatives = require('./representatives.js')
const axios = require('axios')
const path = require('path')
const fs = require('fs-extra')
const {TwitterApi} = require('twitter-api-v2')
const argv = require('minimist')(process.argv.slice(2))
const turf = require('@turf/turf')
const assert = require('node:assert/strict')

const assetDirectory = `./assets-${argv.location}`

const daysToTweet = argv.days ? Number(argv.days) : 1


/**
 * Temporarily halts program execution.
 * @param {Number} ms number of miliseconds to wait
 * @returns promise
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Makes a GET request to Citizen to fetch 200 recent incidents. Using 200 because I think that
 * shgould be a high enough limit to grab all incidents for a given day.
 * @returns JSON list of incidents.
 */
const fetchIncidents = async () => {
  const location = keys[argv.location]
  const limit = 200 * daysToTweet // 200 was not high enough for NYC data
  // https://citizen.com/api/incident/trending?lowerLatitude=37.425128&lowerLongitude=-77.669312&upperLatitude=37.716030&upperLongitude=-77.284938&fullResponse=true&limit=200
  const citizenUrl = `https://citizen.com/api/incident/trending?lowerLatitude=${location.lowerLatitude}&lowerLongitude=${location.lowerLongitude}&upperLatitude=${location.upperLatitude}&upperLongitude=${location.upperLongitude}&fullResponse=true&limit=${limit}`
  console.log('citizenUrl', citizenUrl);
  const response = await axios({
    url: citizenUrl,
    method: 'GET',
  })

  return response
}

/**
 * Makes a GET request to download a geojson file of City Council Districts.
 * @param {String} url url of the geojson file to download
 * @returns resolved promise.
 */
const downloadCityCouncilPolygons = async (url) => {
  const geojsonPath = path.resolve(__dirname, `${assetDirectory}/city_council_districts.geojson`)
  const writer = fs.createWriteStream(geojsonPath)

  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream'
  })

  return new Promise(resolve => response.data.pipe(writer).on('finish', resolve))
}

/**
 * Makes GET requests to download map images of an incident.
 * @param {String} incident the incident to download images for
 * @param {String} eventKey the ID of the citizen incident
 * @returns resolved promise.
 */
const downloadMapImages = async (incident, eventKey) => {
  const citizenMapImagePath = path.resolve(__dirname, `${assetDirectory}/${eventKey}.png`)
  const citizenMapWriter = fs.createWriteStream(citizenMapImagePath)
  const citizenMapResponse = await axios({
    url: incident.shareMap,
    method: 'GET',
    responseType: 'stream',
  })

  if (argv.tweetSatellite && keys[argv.location].googleKey) {
    const googleSatelliteImagePath = path.resolve(__dirname, `${assetDirectory}/${eventKey}_satellite.png`)
    const googleSatelliteWriter = fs.createWriteStream(googleSatelliteImagePath)
    const googleSatUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${incident.latitude},${incident.longitude}&size=500x500&zoom=20&maptype=hybrid&scale=2&key=${keys[argv.location].googleKey}`
    const googleSatelliteResponse = await axios({
      url: googleSatUrl,
      method: 'GET',
      responseType: 'stream',
    })

    return Promise.all([
      new Promise(resolve => citizenMapResponse.data.pipe(citizenMapWriter).on('finish', resolve)),
      new Promise(resolve => googleSatelliteResponse.data.pipe(googleSatelliteWriter).on('finish', resolve)),
    ])
  }

  return new Promise(resolve => citizenMapResponse.data.pipe(citizenMapWriter).on('finish', resolve))
}

const mapCoordinateToCityCouncilDistrict = (coordinate, cityCouncilFeatures) => {
  for (let i = 0; i < cityCouncilFeatures.length; i++) {
    if (turf.booleanPointInPolygon(coordinate, cityCouncilFeatures[i])) {
      return cityCouncilFeatures[i].properties.NAME
    }
  }

  return null
}

const mapIncidentsToCityCouncilDistricts = (incidents) => {
  const cityCouncilFeatureCollection = turf.featureCollection(
    JSON.parse(fs.readFileSync(`${assetDirectory}/city_council_districts.geojson`))
  ).features.features

  return incidents.map(x => {
    return {
      ...x,
      cityCouncilDistrict: mapCoordinateToCityCouncilDistrict(
        turf.point([x.longitude, x.latitude]),
        cityCouncilFeatureCollection
      ),
    }
  })
}

/**
 * Deletes asset folder from disk, and then re-creates it.
 */
const resetAssetsFolder = () => {
  fs.removeSync(assetDirectory)
  fs.ensureDirSync(assetDirectory)
}

/**
 * Tweets thread on a Citizen incident that includes a Pedestrian or Bicyclist
 * @param {*} client the instantiated Twitter client
 * @param {*} incident the Citizen incident to tweet
 */
const tweetIncidentThread = async (client, incident) => {
  const incidentDate = new Date(incident.ts).toLocaleString('en-US', {timeZone: keys[argv.location].timeZone})
  const tweets = []
  const media_ids = []

  // Upload map images and add alt text
  const citizenMapMediaId = await client.v1.uploadMedia(`${assetDirectory}/${incident.key}.png`)
  await client.v1.createMediaMetadata(citizenMapMediaId, {alt_text: {text: `A photo of a map at ${incident.address}. Coordinates: ${incident.latitude}, ${incident.longitude}`}})
  media_ids.push(citizenMapMediaId)

  if (argv.tweetSatellite) {
    const satelliteMapMediaId = await client.v1.uploadMedia(`${assetDirectory}/${incident.key}_satellite.png`)
    await client.v1.createMediaMetadata(satelliteMapMediaId, {alt_text: {text: `A satellite photo of a map at ${incident.address}. Coordinates: ${incident.latitude}, ${incident.longitude}`}})
    media_ids.push(satelliteMapMediaId)
  }

  // Add initial tweet with map image linked
  tweets.push({text: `${incident.raw}\n\n${incidentDate}`, media: {media_ids}})

  for (const updateKey in incident.updates) {
    if (incident.updates[updateKey].type != 'ROOT') {
      const updateTime = new Date(incident.updates[updateKey].ts).toLocaleString('en-US', {timeZone: keys[argv.location].timeZone})
      tweets.push(`${incident.updates[updateKey].text}\n\n${updateTime}`)
    }
  }

  if (argv.tweetReps && representatives[argv.location][incident.cityCouncilDistrict] && incident.cityCouncilDistrict) {
    const representative = representatives[argv.location][incident.cityCouncilDistrict]
    tweets.push(`This incident occurred in ${representatives[argv.location].repesentativeDistrictTerm} ${incident.cityCouncilDistrict}. \n\nRepresentative: ${representative}`)
  }
  try {
    console.log('num tweets in thread: ', tweets.length)
    await client.v2.tweetThread(tweets)
  } catch (err) {
    console.log('error on tweetIncidentThread: ', err)
  }
}

/**
 * Tweets number of relevant Citizen incidents over the last 24 hours.
 * @param {*} client the instantiated Twitter client
 * @param {*} incidents the relevant Citizen incidents
 */
const tweetSummaryOfLast24Hours = async (client, incidents, summary) => {
  const numIncidents = incidents.length
  const lf = new Intl.ListFormat('en')
  const {hitAndRuns, pedBikeIncidents, overturnedVehicles, collisions, vehicularAssault} = summary
  let firstTweet = numIncidents > 0
    ? `There ${numIncidents === 1 ? 'was' : 'were'} ${numIncidents} incident${numIncidents === 1 ? '' : 's'} of traffic violence found over the last ${daysToTweet === 1 ? '24 hours' : `${daysToTweet} days`}.
    ${pedBikeIncidents > 0 ? `\n${pedBikeIncidents} involved pedestrians or cyclists` : ''}
    ${hitAndRuns > 0 ? `\n${hitAndRuns} were hit-and-runs` : ''}
    ${vehicularAssault > 0 ? `\n${vehicularAssault} involved vehicular assault` : ''}
    ${overturnedVehicles > 0 ? `\n${overturnedVehicles} involved overturning/flipping vehicles` : ''}
    ${collisions > 0 ? `\n${collisions === numIncidents ? `All` : `${collisions}`} were collisions` : ''}`
    : `There were no incidents of traffic violence reported to 911 today in the ${argv.location} area.`
  const disclaimerTweet = `Disclaimer: This bot tweets incidents called into 911 and is not representative of all traffic violence that occurred.`
  const tweets = [firstTweet]
  if (numIncidents > 0) {
    tweets.push(disclaimerTweet)
  }

  if (numIncidents > 0 && argv.tweetReps) {
    if (argv.tweetReps) {
      const districts = [...new Set(incidents.map(x => x.cityCouncilDistrict))].sort()
      const districtSentenceStart = numIncidents === 1 ? 'The crash occurred in' : 'The crashes occurred in'
      const districtSentenceEnd = districts.length === 1
        ? `${representatives[argv.location].repesentativeDistrictTerm} ${lf.format(districts)}`
        : `${representatives[argv.location].repesentativeDistrictTerm}s ${lf.format(districts)}`

      tweets[0] = `${firstTweet}\n\n${districtSentenceStart} ${districtSentenceEnd}.`
    }

    if (argv.tweetReps && representatives[argv.location].atLarge) {
      const atLargeRepInfo = representatives[argv.location].atLarge
      tweets.push(`At large city council representatives and president: ${lf.format(atLargeRepInfo)}`)
    }
  }

  try {
    await client.v2.tweetThread(tweets)
  } catch (err) {
    console.log('error on tweetSummaryOfLast24Hours: ', err)
  }

}

/**
 * Filters Citizen incidents and returns ones not involving weapons or robbery.
 * @param {Array} array an array of Citizen incidents
 * @returns an array of Citizen incidents not involving weapons or robbery
 */
const excludeWeaponsAndRobbery = (array) => array.filter(x =>
  !containsWeaponsAndRobberyText(x.raw.toLowerCase())
);

const containsWeaponsAndRobberyText = (text) =>
  text.includes('robbed') ||
  text.includes('buglar') ||
  text.includes('breaking into') ||
  text.includes('stolen') ||
  text.includes('gunmen') ||
  text.includes('gunman') ||
  text.includes('gunfire') ||
  text.includes('armed') ||
  text.includes('fled');

/**
 * Filters Citizen incidents and returns ones involving Pedestrian and Bicyclists.
 * @param {Array} allIncidents an array of Citizen incidents
 * @returns an array of Citizen incidents mentioning Pedestrians or Bicyclists.
 */
const filterPedBikeIncidents = (potentialIncidents) => {
  // Get incidents from the last 24 hours with pedestrian or bicyclist in the top level description
  return potentialIncidents.filter(x => containsPedBikeText(x.raw.toLowerCase()));
}

const containsPedBikeText = (text) =>
  text.includes('pedestrian') ||
  text.includes('cyclist') ||
  text.includes('struck by vehicle') ||
  text.includes('hit by vehicle') ||
  text.includes('bicycle') ||
  text.includes('scooter');

// include vehicle collision but exclude pedestrian, bike, etc
const filterVehicleOnlyIncidents = (nonPedBikeInicidents) =>
  nonPedBikeInicidents.filter(x => containsVehicleOnlyText(x.raw.toLowerCase()));


const containsVehicleOnlyText = (text) =>
  text.includes('vehicle crashed') ||
  text.includes('vehicle collision') ||
  text.includes('vehicle flipped') ||
  text.includes('overturned vehicle') ||
  text.includes('dragging vehicle') ||
  text.includes('hit-and-run');

const filterOtherIncidents = (allIncidents) =>
  allIncidents.filter(x =>
    x.raw.toLowerCase().includes('vehicular assault')
  );

const filterIncidentsWithPedBikeUpdates = (incidents) =>
  incidents.filter(x => {
      for (const updateObjectKey in x.updates) {
        const updateText = x.updates[updateObjectKey].text.toLowerCase()
        if (!containsWeaponsAndRobberyText(updateText) && containsPedBikeText(updateText)) {
          return true
        }
      }
      return false
    }
  )

const validateInputs = () => {
  assert.notEqual(argv.location, undefined, 'location must be passed in')
  assert.notEqual(keys[argv.location], undefined, 'keys file must have location information')

  if (argv.tweetSatellite) {
    assert.notEqual(keys[argv.location].googleKey, undefined, 'keys file must contain googleKey for location if calling with tweetSatellite flag')
  }

  if (argv.tweetReps) {
    assert.notEqual(representatives[argv.location], undefined, 'must have representative info for location if calling with tweetReps flag')
    assert.notEqual(representatives[argv.location].geojsonUrl, undefined, 'must have geojsonUrl set so incidents can be mapped to representative districts if calling with tweetReps flag')
    assert.notEqual(representatives[argv.location].repesentativeDistrictTerm, undefined, 'must have repesentativeDistrictTerm set if calling with tweetReps flag')
  }
}

const handleIncidentTweets = async (client, filteredIncidents) => {

  if (argv.tweetReps) {
    await downloadCityCouncilPolygons(representatives[argv.location].geojsonUrl)
    filteredIncidents = mapIncidentsToCityCouncilDistricts(filteredIncidents)
  }

  for (const incident of filteredIncidents) {
    console.log(incident.raw)

    try {
      await downloadMapImages(incident, incident.key)
    } catch (err) {
      console.log('error on downloadMapImages: ', err)
    }
    await tweetIncidentThread(client, incident)

    // wait one minute to prevent rate limiting... or 3 secs generally works
    await delay(4000)
  }
}

const tweetIncidentSummaryFile = `./archive/tweetIncidentSummaries-${argv.location}.json`

const saveIncidentSummaries = (array) => {
  fs.writeFile(
    tweetIncidentSummaryFile,
    JSON.stringify(
      array.map(obj => ({
        key: obj.key,
        raw: obj.raw,
        ts: obj.ts,
        date: new Date(obj.ts).toLocaleString('en-US', {timeZone: keys[argv.location].timeZone}),
        ll: obj.ll,
        shareMap: obj.shareMap,
        updates: obj.updates
      }))
    )
  )
}

const eliminateDuplicateIncidents = (array) => {
  let previouslySavedList = [];
  try {
    const summaryFile = fs.readFileSync(tweetIncidentSummaryFile);
    previouslySavedList = JSON.parse(summaryFile);
  } catch (err) {
    console.log('error reading file: ', err.message);
  }
  const incidentKeys = previouslySavedList.map(summary => summary.key);
  const finalList = array.filter(obj => incidentKeys.indexOf(obj.key) === -1);
  // this is dumb but undefined is getting in there and i'm not going to figure out why now.
  saveIncidentSummaries([...previouslySavedList, ...finalList]);
  return {finalList, previouslySavedList};
}

const excludeList = (fullList, listToExclude) => {
  const raws = listToExclude.map(x => x.raw);
  return fullList.filter(x => raws.indexOf(x.raw) === -1);
}

const handleFiltering = (potentialIncidents) => {
  // TODO: build summary obj first including updates. one fn, checks raw and updates for passed-in string
  const pedBikeIncidents = filterPedBikeIncidents(potentialIncidents);
  // remove ped/bike incidents from list to see if others are vehicle only
  const remainingIncidents = excludeList(potentialIncidents, pedBikeIncidents);
  const incidentsWithRelevantUpdates = filterIncidentsWithPedBikeUpdates(remainingIncidents);
  const vehicleOnlyIncidents = filterVehicleOnlyIncidents(remainingIncidents);
  const otherIncidents = filterOtherIncidents(excludeList(remainingIncidents, vehicleOnlyIncidents))
  const fullIncidentList = [...vehicleOnlyIncidents, ...incidentsWithRelevantUpdates, ...otherIncidents, ...pedBikeIncidents];
  const rawTextArr = fullIncidentList.map(x => x.raw.toLowerCase());
  return {
    incidentList: fullIncidentList,
    summary: {
      pedBikeIncidents: pedBikeIncidents.length + incidentsWithRelevantUpdates.length,
      hitAndRuns: rawTextArr.filter(x => x.includes('hit-and-run')).length,
      overturnedVehicles: rawTextArr.filter(x => (x.includes('overturned vehicle') || (x.includes('flipped') && x.includes('vehicle')))).length,
      vehicularAssault: rawTextArr.filter(x => x.includes('vehicular assault')).length,
      collisions: rawTextArr.filter(x => x.includes('collision')).length
    }
  };
}

const main = async () => {
  validateInputs();
  const keysObj = keys[argv.location];

  const client = new TwitterApi({
    appKey: keysObj.consumer_key,
    appSecret: keysObj.consumer_secret,
    accessToken: keysObj.access_token,
    accessSecret: keysObj.access_token_secret,
  });

  const citizenResponse = await fetchIncidents();
  const allIncidents = citizenResponse.data.results;
  console.log('Incidents total: ', allIncidents.length);

  if (allIncidents.length === 0) {
    await client.v2.tweet(`The Citizen App's 911 reporting service for ${argv.location} seems to be down today. Travel safely out there!`);
  } else {
    resetAssetsFolder();

    const targetTimeInMs = Date.now() - (86400000 * daysToTweet);
    const currentIncidents = allIncidents.filter(x => x.ts >= targetTimeInMs);
    const potentialIncidents = excludeWeaponsAndRobbery(currentIncidents);

    let {incidentList, summary} = handleFiltering(potentialIncidents);

    // check for saved duplicates
    const {finalList, previouslySavedList} = eliminateDuplicateIncidents(incidentList);

    console.log('incident list raw', finalList.map(i => i.raw));
    await handleIncidentTweets(client, finalList);

    // tweet the summary last because then it'll always be at the top of the timeline
    tweetSummaryOfLast24Hours(client, finalList, summary);

    saveIncidentSummaries([...previouslySavedList, ...finalList]);
  }
}

main();
// eliminateDuplicateIncidents([]);
// fetchIncidents();

module.exports = {
  filterIncidentsWithPedBikeUpdates,
  filterVehicleOnlyIncidents,
  filterPedBikeIncidents,
  handleFiltering
}