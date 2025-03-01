const keys = require('./keys.js')
const representatives = require('./representatives.js')
const axios = require('axios')
const path = require('path')
const fs = require('fs-extra')
const {TwitterApi} = require('twitter-api-v2')
const argv = require('minimist')(process.argv.slice(2))
const turf = require('@turf/turf')
const assert = require('node:assert/strict')

const assetDirectory = `./assets/${argv.location}`
const currentDate = new Date();
const currentMs = Date.now();
const botRunTimeFilePath = `./archive/${argv.location}/${argv.location}-runtime.txt`;
const summaryStem = `./archive/${argv.location}/${argv.location}-summaries-`;
const currentSummaryFilePath = `${summaryStem}${currentDate.getMonth()}-${currentDate.getFullYear()}.json`
const prevYear = currentDate.getMonth() === 0 ? currentDate.getFullYear() - 1 : currentDate.getFullYear();
const prevMonth = currentDate.getMonth() === 0 ? '11' : currentDate.getMonth() - 1;
const prevSummaryFilePath = `${summaryStem}${prevMonth}-${prevYear}.json`
const errorFilePath = `./errors/${argv.location}/${argv.location}-errors-${currentDate.getMonth()}-${currentDate.getFullYear()}.json`

const daysToTweet = argv.days ? Number(argv.days) : 0;
const hoursToTweet = argv.hours ? Number(argv.hours) : 0;

let lastRunTime = 0;
const oneDayInMs = 86400000;
try {
  lastRunTime = JSON.parse(fs.readFileSync(botRunTimeFilePath));
} catch (e) {
  console.log('error reading bot runtime file: ', e.message)
  // set last run time to one day ago if file doesn't exist
  lastRunTime = currentMs - oneDayInMs;
  fs.writeFileSync(botRunTimeFilePath, JSON.stringify(lastRunTime))

  console.log('wrote file: ', botRunTimeFilePath)
}
const targetTimeInMs = daysToTweet || hoursToTweet
  ? Date.now() - (oneDayInMs * daysToTweet) - (oneDayInMs / 24 * hoursToTweet)
  : lastRunTime;

const keysObj = keys[argv.location];

const client = new TwitterApi({
  appKey: keysObj.consumer_key,
  appSecret: keysObj.consumer_secret,
  accessToken: keysObj.access_token,
  accessSecret: keysObj.access_token_secret,
});


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
  const limit = daysToTweet ? 1000 * daysToTweet : 2000 // 800 was not high enough for one day Philly data
  const citizenUrl = `https://citizen.com/api/incident/trending?lowerLatitude=${location.lowerLatitude}&lowerLongitude=${location.lowerLongitude}&upperLatitude=${location.upperLatitude}&upperLongitude=${location.upperLongitude}&fullResponse=true&limit=${limit}`
  console.log(`${argv.location} url: `, citizenUrl);
  try {
    return axios({
      url: citizenUrl,
      method: 'GET',
    })
  } catch (e) {
    console.log('error getting citizen data: ', e.message)
  }
}

/**
 * Makes a GET request to download a geojson file of City Council Districts.
 * Use this if you're hosting the file somewhere other than this repo.
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
  try {
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
  } catch (e) {
    console.log('error downloading map images: ', e.message)
  }
}

const mapCoordinateToCityCouncilDistrict = (coordinate, cityCouncilFeatures) => {
  for (let i = 0; i < cityCouncilFeatures.length; i++) {
    if (turf.booleanPointInPolygon(coordinate, cityCouncilFeatures[i])) {
      return cityCouncilFeatures[i].properties.NAME
    }
  }

  return null
}

// debug this
const mapIncidentsToCityCouncilDistricts = (incidents) => {
  const cityCouncilFeatureCollection = turf.featureCollection(
    JSON.parse(fs.readFileSync(`repsGeoJSON/representatives-${argv.location}.geojson`))
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
const tweetIncidentThread = async (incident) => {
  // trim date down to mm/dd/yyyy hh:mm format
  const incidentDate = new Date(incident.ts).toLocaleString('en-US', {timeZone: keys[argv.location].timeZone}).replace(/(.*)\D\d+ /, '$1');
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
  let rep = '';
  if (
    argv.tweetReps
    && representatives[argv.location][incident.cityCouncilDistrict]
  ) {
    const representative = representatives[argv.location][incident.cityCouncilDistrict];
    let district = '';
    if (Number(incident.cityCouncilDistrict)) {
      district = `${representatives[argv.location].repesentativeDistrictTerm} ${incident.cityCouncilDistrict}`;
    } else {
      const countyAbbrev = incident.cityCouncilDistrict.slice(0, 1);
      district = `${representatives[argv.location][`${countyAbbrev.toLowerCase()}RepesentativeDistrictTerm`]} ${incident.cityCouncilDistrict.slice(1)}`;
    }
    rep = `${district}, representative ${representative}`
  }
  // Add initial tweet with map image linked and representative info if available
  tweets.push({text: `${incident.raw}\n\n${rep ? `${rep}\n` : ''}${incidentDate}`, media: {media_ids}})

  for (const updateKey in incident.updates) {
    if (incident.updates[updateKey].type !== 'ROOT') {
      const updateTime = new Date(incident.updates[updateKey].ts).toLocaleString('en-US', {timeZone: keys[argv.location].timeZone})
      tweets.push(`${incident.updates[updateKey].text}\n\n${updateTime}`)
    }
  }

  const filteredTweets = tweets.filter(tweet => tweet);
  try {
    await client.v2.tweetThread(filteredTweets);
  } catch (err) {
    console.log('error on tweetIncidentThread: ', err.message);
    console.log('errored filtered thread', filteredTweets);
    let errFile;
    try {
      errFile = fs.readFileSync(errorFilePath);
      const errors = JSON.parse(errFile);
      fs.writeFile(
        errorFilePath,
        JSON.stringify([...errors, tweets])
      );
      console.log('wrote file: ', errorFilePath);
    } catch (e) {
      fs.writeFile(errorFilePath, JSON.stringify([tweets]));
      console.log('wrote file: ', errorFilePath);
    }
  }
}

/**
 * Tweets number of relevant Citizen incidents over the last 24 hours.
 * @param {*} client the instantiated Twitter client
 * @param {*} incidents the relevant Citizen incidents
 */
const tweetSummaryOfLast24Hours = async (numFromCitizen = null) => {
  const summaryFile = fs.readFileSync(currentSummaryFilePath);
  let allIncidents = [];
  try {
    allIncidents = JSON.parse(summaryFile);
  } catch (e) {
    console.log('error reading summary file: ', e.message)
  }

  const currentIncidents = allIncidents.filter(x => x.ts >= targetTimeInMs);
  const {summary} = handleFiltering(currentIncidents);
  const {hitAndRuns, pedBikeIncidents, overturnedVehicles, collisions, vehicularAssault, injuries} = summary;
  const numIncidents = currentIncidents.length;
  const lf = new Intl.ListFormat('en');

  const timeToIndicate = () => {
    if (daysToTweet === 1) {
      return hoursToTweet === 0 ? '24 hours' : `${Number(1 + (hoursToTweet / 24).toFixed(2))} days`;
    } else if (daysToTweet > 1) {
      return `${hoursToTweet ? daysToTweet + Number((hoursToTweet / 24).toFixed(2)) : daysToTweet} days`
    } else if (hoursToTweet > 0) {
      return `${hoursToTweet} hours`
    } else {
      const days = ((currentMs - lastRunTime) / oneDayInMs).toFixed(2);
      return `${days} days`
    }
  }

  let firstTweet = numIncidents > 0
    ? `There ${numIncidents === 1 ? 'was' : 'were'} ${numIncidents} incident${numIncidents === 1 ? '' : 's'} of traffic violence found over the last ${timeToIndicate()}${numFromCitizen ? ` out of a total of ${numFromCitizen} incidents` : ''}.${pedBikeIncidents || hitAndRuns || injuries || collisions || overturnedVehicles || vehicularAssault ? `\n` : ''}${pedBikeIncidents > 0 ? `\n${pedBikeIncidents} involved pedestrians or cyclists` : ''}${injuries > 0 ? `\n${injuries} resulted in injuries` : ''}${hitAndRuns > 0 ? `\n${hitAndRuns} ${hitAndRuns === 1 ? 'was a hit-and-run' : 'were hit-and-runs'}` : ''}${vehicularAssault > 0 ? `\n${vehicularAssault} involved vehicular assault` : ''}${overturnedVehicles > 0 ? `\n${overturnedVehicles} involved overturning/flipping vehicles` : ''}${collisions > 0 ? `\n${collisions === numIncidents ? `All` : `${collisions}`} were collisions` : ''}`
    : `There were no incidents of traffic violence reported to 911 over the last ${timeToIndicate()} in the ${argv.location} area.`
  const disclaimerTweet = `Disclaimer: This bot tweets incidents called into 911 and is not representative of all traffic violence that occurred. Injuries reported here may have been fatal.`

  const tweets = [firstTweet]

  if (numIncidents > 0 && argv.tweetReps) {
    // TODO: not working right for KC, districts is empty
    // const districts = Array.from(new Set(incidents.map(x => x.cityCouncilDistrict))).sort()
    // console.log('tweetSummary districts', districts)
    // if (argv.tweetReps) {
    //   const districtSentenceStart = numIncidents === 1 ? 'The crash occurred in' : 'The crashes occurred in'
    //   tweets.push(`${districtSentenceStart} ${representatives[argv.location].repesentativeDistrictTerm}${districts.length === 1 ? '' : 's'} ${districts.join(', ')}.`)
    // }

    if (argv.tweetReps && representatives[argv.location].atLarge) {
      const atLargeRepInfo = representatives[argv.location].atLarge
      tweets.push(`At large city council representatives and president: ${lf.format(atLargeRepInfo)}`)
    }
  }

  // add a tweet tagging city reps in after the summary
  if (representatives[argv.location].list && representatives[argv.location].list.length) {
    const councilMembersAndTagsTweet = `${representatives[argv.location].list.join(' ')}`
    tweets.push(councilMembersAndTagsTweet)
  }

  tweets.push(disclaimerTweet)

  try {
    await client.v2.tweetThread(tweets)
  } catch (err) {
    console.log('error on tweetSummaryOfLast24Hours: ', err.message)
    console.log('errored out tweets', tweets)
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

const containsOtherDangerText = (text) =>
  text.includes('car engulfed in flames') ||
  text.includes('car engulfed in flames') ||
  text.includes('car engulfed in flames');

const containsWeaponsAndRobberyText = (text) =>
  text.includes('unfounded') ||
  text.includes('robbed') ||
  text.includes('robber') ||
  text.includes('burglar') ||
  text.includes('breaking into') ||
  text.includes('broke into') ||
  text.includes('stolen') ||
  text.includes('gunmen') ||
  text.includes('gunman') ||
  text.includes('gunpoint') ||
  text.includes('gunfire') ||
  text.includes('armed') ||
  text.includes('fled');

/**
 * Filters Citizen incidents and returns ones involving Pedestrian and Bicyclists.
 * @param {Array} potentialIncidents an array of Citizen incidents
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
  (text.includes('car') && text.includes('crash')) ||
  (text.includes('car') && text.includes('collision')) ||
  text.includes('vehicle crashed') ||
  text.includes('vehicle careened') ||
  text.includes('vehicle collision') ||
  text.includes('dragging vehicle');

const containsFlippedText = (text) =>
  text.includes('vehicle flipped') ||
  text.includes('overturned vehicle');

const containsHitAndRunText = (text) => text.includes('hit-and-run');

const filterAssault = (allIncidents) =>
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

const handleIncidentTweets = async (filteredIncidents) => {

  if (argv.tweetReps) {
    // disabled due to storing geojson file in repo
    // await downloadCityCouncilPolygons(representatives[argv.location].geojsonUrl)
    filteredIncidents = mapIncidentsToCityCouncilDistricts(filteredIncidents)
  }

  for (const incident of filteredIncidents) {
    console.log(incident.cityCouncilDistrict, ' -- ', incident.raw)

    try {
      await downloadMapImages(incident, incident.key)
    } catch (err) {
      console.log('error on downloadMapImages: ', err.message)
    }
    await tweetIncidentThread(incident)

    // wait one minute to prevent rate limiting... or 3-4 secs generally works
    // on a brand-new account, i had it set at 2 seconds (working for established accounts),
    // but it cut me off midway through the tweets. using 30 secs had no issues with a long list
    // i do get occasional errors on threads but the initial tweet goes in that case.
    // I don't know what is wrong with the follow-up ones
    await delay(20000)
  }
}


const saveIncidentSummaries = (array) => {
  fs.writeFile(
    currentSummaryFilePath,
    JSON.stringify(
      // @TODO: fix for incidents somehow being duplicated in the summary file
      Array.from(new Set(array.map(obj => getSummarizedIncident(obj))))
    )
  )
}

const saveBotRunTime = () => {
  fs.writeFile(
    botRunTimeFilePath, JSON.stringify(currentMs)
  )
}


const getSummarizedIncident = (incident) => ({
  key: incident.key,
  raw: incident.raw,
  ts: incident.ts,
  date: new Date(incident.ts).toLocaleString('en-US', {timeZone: keys[argv.location].timeZone}),
  ll: incident.ll,
  longitude: incident.longitude,
  latitude: incident.latitude,
  shareMap: incident.shareMap,
  updates: incident.updates,
  cityCouncilDistrict: incident.cityCouncilDistrict || null
})

const eliminateDuplicateIncidents = (array) => {
  let currentMonthList = [];
  let prevMonthList = [];
  if (currentDate.getDay() < 3) {
    try {
      prevMonthList = JSON.parse(fs.readFileSync(prevSummaryFilePath));
    } catch (e) {
      console.log('error reading prev month summary file: ', e.message);
    }
  }
  try {
    const summaryFile = fs.readFileSync(currentSummaryFilePath);
    currentMonthList = JSON.parse(summaryFile);
  } catch (err) {
    console.log('error reading file: ', err.message);
    fs.writeFile(currentSummaryFilePath, '[]')
    console.log('wrote file: ', currentSummaryFilePath)
  }
  const prevMonthKeys = prevMonthList.map(i => i.key);
  const withoutIncidentsFromLastMonth = array.filter(incident => !prevMonthKeys.includes(incident.key))
  const unique = [...new Map([...currentMonthList, ...withoutIncidentsFromLastMonth].map(incident => [incident.key, incident])).values()]
  saveIncidentSummaries(unique);
  return unique.filter(x => x.ts >= targetTimeInMs)
}

const excludeList = (fullList, listToExclude) => {
  const raws = listToExclude.map(x => x.raw);
  return fullList.filter(x => raws.indexOf(x.raw) === -1);
}

const handleFiltering = (potentialIncidents) => {
  const pedBikeIncidents = filterPedBikeIncidents(potentialIncidents);
  // remove ped/bike incidents from list to see if others are vehicle only
  const remainingIncidents = excludeList(potentialIncidents, pedBikeIncidents);
  const incidentsWithRelevantUpdates = filterIncidentsWithPedBikeUpdates(remainingIncidents);
  const flips = remainingIncidents.filter(i => containsFlippedText(i.raw.toLowerCase()));
  const hitAndRuns = remainingIncidents.filter(i => containsHitAndRunText(i.raw.toLowerCase()));
  const vehicleOnlyIncidentsSorted = filterVehicleOnlyIncidents(remainingIncidents).sort((a, b) => a.ts - b.ts);
  const assaults = filterAssault(excludeList(remainingIncidents, vehicleOnlyIncidentsSorted))
  const fullIncidentList = [...vehicleOnlyIncidentsSorted, ...flips, ...hitAndRuns, ...assaults, ...incidentsWithRelevantUpdates, ...pedBikeIncidents];
  const rawTextArr = fullIncidentList.map(x => x.raw.toLowerCase());
  return {
    incidentList: fullIncidentList,
    summary: {
      pedBikeIncidents: pedBikeIncidents.length + incidentsWithRelevantUpdates.length,
      hitAndRuns: rawTextArr.filter(x => x.includes('hit-and-run')).length,
      overturnedVehicles: rawTextArr.filter(x => (x.includes('overturned vehicle') || (x.includes('flipped') && x.includes('vehicle')))).length,
      vehicularAssault: rawTextArr.filter(x => x.includes('vehicular assault')).length,
      collisions: rawTextArr.filter(x => x.includes('collision')).length,
      injuries: rawTextArr.filter(x => x.includes('injur')).length
    }
  };
}

const tweetIncidentsAfterTs = async (ts) => {
  const summaryFile = fs.readFileSync(currentSummaryFilePath);
  const allIncidents = JSON.parse(summaryFile);
  const incidents = allIncidents.filter(x => x.ts > ts);
  await handleIncidentTweets(incidents);
  tweetSummaryOfLast24Hours();
}

const tweetApiDown = () => client.v2.tweet(`The Citizen App or 911 reporting data relay service for ${argv.location} seems to be down today. Travel safely out there!`);

const main = async () => {
  validateInputs();

  const citizenResponse = await fetchIncidents();
  const allIncidents = citizenResponse.data.results;
  const currentIncidents = allIncidents.filter(x => x.ts >= targetTimeInMs);
  console.log(`${argv.location} current incidents: `, currentIncidents.length);
  console.log(currentIncidents.map(i => i.raw).filter(t =>
    !containsVehicleOnlyText(t)
    && (t.toLowerCase().includes('vehicle')
      || t.toLowerCase().includes('car'))
  ))
  if (currentIncidents.length === 0) {
    tweetApiDown();
  } else {
    // resetAssetsFolder();
    const potentialIncidents = excludeWeaponsAndRobbery(currentIncidents);

    let {incidentList} = handleFiltering(potentialIncidents);
    // check for saved duplicates and return the ones that current
    const finalList = eliminateDuplicateIncidents(incidentList);
    await handleIncidentTweets(finalList);
    // tweet the summary last because then it'll always be at the top of the timeline
    tweetSummaryOfLast24Hours(currentIncidents.length);
    saveBotRunTime();
  }
}

main();
// eliminateDuplicateIncidents([]);
// tweetIncidentsAfterTs(1671732747000)
// tweetSummaryOfLast24Hours();


// @TODO: build out functionality to read archives and post week/month summaries

module.exports = {
  filterIncidentsWithPedBikeUpdates,
  filterVehicleOnlyIncidents,
  filterPedBikeIncidents,
  handleFiltering
}