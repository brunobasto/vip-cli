#!/usr/bin/env node
// @flow

/**
 * External dependencies
 */
import {
	Harmonia,
	SiteConfig,
	EnvironmentVariables,
	TestSuite,
	TestSuiteResult,
	Test,
	TestResult,
	TestResultType,
	IssueType,
} from '@automattic/vip-go-preflight-checks';

import path from 'path';
import gql from 'graphql-tag';
import { readFileSync } from 'fs';
import dotenv from 'ini';
import chalk from 'chalk';

/**
 * Internal dependencies
 */
import command from 'lib/cli/command';
import * as exit from 'lib/cli/exit';
import { default as API, enableGlobalGraphQLErrorHandling, disableGlobalGraphQLErrorHandling } from '../lib/api';
import { trackEvent } from 'lib/tracker';

export const appQuery = `
	id
	name
	repo
	environments {
		id
		appId
		name
		type
		environmentVariables {
			nodes {
				name,
				value
			}
		}
	}
	organization {
		id
		name
	}
`;

let suppressOutput = false;
let outputJson = false;

let harmoniaArgs = [];

function logToConsole( ...messages: string[] ) {
	if ( suppressOutput ) {
		return;
	}

	if ( messages.length === 0 ) {
		messages = [ '' ];
	}

	messages.forEach( message => console.log( message ) );
}

async function getBuildConfiguration( application, environment ) {
	const api = await API();

	// Disable the global GraphQL error handling, so we can catch Unauthorized errors and recommend next steps.
	disableGlobalGraphQLErrorHandling();

	const buildConfigQuery = gql`
	query BuildConfig( $appId: Int, $envId: Int ) {
        app(id: $appId) {
            environments(id: $envId) {
                id,
                buildConfiguration {
					buildType
					nodeBuildDockerEnv,
					nodeJSVersion,
					npmToken,
                }
            }
        }
	}`;

	try {
		const result = await api.query( {
			query: buildConfigQuery,
			fetchPolicy: 'network-only',
			variables: {
				appId: environment.appId,
				envId: environment.id,
			},
		} );

		// Reenable GraphQL error handling
		enableGlobalGraphQLErrorHandling();

		return result.data.app.environments[ 0 ].buildConfiguration;
	} catch ( error ) {
		if ( error.graphQLErrors && error.graphQLErrors.find( gqlError => gqlError.message === 'Unauthorized' ) ) {
			console.log( `${ chalk.red( 'Error:' ) } You don't have the required permissions to run validations for this environment.\n` +
				`You must be either be an admin of the ${ chalk.bold.underline( application.organization.name ) } organization, or, alternatively,\n` +
				`a guest of that organization and an admin of the ${ chalk.bold.underline( application.name ) } application.\n\n` +
				'You can read more about organization and application roles on our documentation:\n' +
				chalk.underline( 'https://docs.wpvip.com/technical-references/enterprise-authentication/' ) );

			await trackEvent( 'validate_preflight_command_error', {
				env_id: environment.id,
				app_id: environment.appId,
				error: 'unauthorized',
			} );

			process.exit( 1 );
		} else {
			// Handle it elsewhere
			throw error;
		}
	}
}

export async function vipValidatePreflightCommand( arg: string[], opt ) {
	harmoniaArgs = await validateArgs( opt );

	const baseTrackingParams = {
		env_id: opt.env.id,
		app_id: opt.env.appId,
		command: 'vip validate preflight',
		...sanitizeArgsForTracking( harmoniaArgs ),
	};

	await trackEvent( 'validate_preflight_command_execute', baseTrackingParams );

	logToConsole( '  /\\  /\\__ _ _ __ _ __ ___   ___  _ __ (_) __ _ ' );
	logToConsole( ' / /_/ / _` | \'__| \'_ ` _ \\ / _ \\| \'_ \\| |/ _` |' );
	logToConsole( '/ __  / (_| | |  | | | | | | (_) | | | | | (_| |' );
	logToConsole( '\\/ /_/ \\__,_|_|  |_| |_| |_|\\___/|_| |_|_|\\__,_|' );
	logToConsole( 'VIP Harmonia - Application testing made easy\n' );

	const harmonia = new Harmonia();
	harmonia.setSource( 'vip-cli' );

	if ( harmoniaArgs.buildType !== 'nodejs' ) {
		await trackEvent( 'validate_preflight_command_error', {
			...baseTrackingParams,
			error: 'not-nodejs',
		} );

		exit.withError( 'Currently, only Node.js applications are supported.' );
	}

	// Register the default tests.
	harmonia.registerDefaultTests();

	// Create the Site Config objects
	const siteOptions = new SiteConfig( {
		siteID: opt.app.id,
		nodejsVersion: harmoniaArgs.nodejsVersion,
		repository: opt.app.repo,
		baseURL: 'http://localhost:' + harmoniaArgs.port,
		dockerBuildEnvs: harmoniaArgs.nodeBuildDockerEnv,
		topRequests: [], // TODO: get top 10 of most requested URLs
		wait: harmoniaArgs.wait,
	} );

	// Get package.json
	const packageJSONfile = path.resolve( opt.path, 'package.json' );
	let packageJSON;
	try {
		packageJSON = require( packageJSONfile );
		siteOptions.setPackageJSON( packageJSON );
	} catch ( error ) {
		await trackEvent( 'validate_preflight_command_error', {
			...baseTrackingParams,
			error: 'missing-package-json',
		} );

		return exit.withError( `Could not find a 'package.json' in the current folder (${ opt.path }).` );
	}

	const customEnvVars = {};

	if ( opt.env.environmentVariables?.nodes.length > 0 ) {
		opt.env.environmentVariables.nodes.forEach( envVar => {
			customEnvVars[ envVar.name ] = envVar.value;
		} );
	}

	// Create the EnviornmentVariables object
	const envVars = new EnvironmentVariables( {
		PORT: harmoniaArgs.port,
		...customEnvVars,
	} );

	// Add NPM_TOKEN environment variable, if present
	if ( harmoniaArgs.npmToken ) {
		envVars.set( 'NPM_TOKEN', harmoniaArgs.npmToken );
	}

	// Get from .env, if exists
	let dotenvOptions: object = {};
	try {
		const dotenvPath = path.resolve( opt.path, '.env' );
		const dotenvContent = readFileSync( dotenvPath );
		dotenvOptions = dotenv.parse( dotenvContent );
	} catch ( error ) {
		// nothing
	}

	// Save dotenv in the site config
	siteOptions.set( 'dotenv', dotenvOptions );

	// Bootstrap
	try {
		harmonia.bootstrap( siteOptions, envVars );
	} catch ( error ) {
		await trackEvent( 'validate_preflight_command_error', {
			...baseTrackingParams,
			error: error.message,
		} );
		return exit.withError( error.message );
	}

	setupEvents( harmonia );
	runHarmonia( harmonia );
}

function setupEvents( harmonia: Harmonia ) {
	// Register some events handlers
	harmonia.on( 'ready', () => {
		logToConsole( 'Harmonia is ready! ' );
	} );

	// Register the event handlers to output some information during the execution
	harmonia.on( 'beforeTestSuite', ( suite: TestSuite ) => {
		const description = suite.description ? `- ${ chalk.italic( suite.description ) }` : '';
		logToConsole( ` >> Running test suite ${ chalk.bold( suite.name ) } ${ description } ` );
		logToConsole();
	} );

	harmonia.on( 'beforeTest', ( test: Test ) => {
		logToConsole( `  [ ${ chalk.bold( test.name ) } ] - ${ test.description }` );
	} );

	harmonia.on( 'afterTest', ( test: Test, result: TestResult ) => {
		switch ( result.getType() ) {
			case TestResultType.Success:
				logToConsole( `   ✅  ${ chalk.bgGreen( ' Test passed with no errors. ' ) }` );
				break;
			case TestResultType.Failed:
				logToConsole( `   ❌  ${ chalk.bgRed( ` Test failed with ${ result.getErrors().length } errors. ` ) }` );
				break;
			case TestResultType.PartialSuccess:
				logToConsole( `   ✅  ${ chalk.bgYellow( ' Test partially succeeded. ' ) }` );
				break;
			case TestResultType.Aborted:
				logToConsole( `   ❌  ${ chalk.bgRedBright.underline( ' Test aborted! ' ) } - There was a critical error that makes`,
					'the application incompatible with the VIP Platform.' );
				break;
			case TestResultType.Skipped:
				logToConsole( `  ${ chalk.bgGrey.bold( ' Skipped ' ) }\t${ result.getLastNotice().message }` );
		}
		logToConsole();
	} );

	harmonia.on( 'afterTestSuite', ( test: TestSuite, result: TestSuiteResult ) => {
		// Create a badge
		let badge;
		switch ( result.getType() ) {
			case TestResultType.Failed:
				badge = chalk.bgRed.bold( ' FAILED ' );
				break;
			case TestResultType.Aborted:
				badge = chalk.bgRedBright.underline.bold( ' ABORTED ' );
				break;
			case TestResultType.PartialSuccess:
				badge = chalk.bgYellow.bold( ' PASS ' );
				break;
			default:
				badge = chalk.bgGreen.bold( ' PASS ' );
				break;
		}

		logToConsole( ` >> ${ badge } Finished running ${ chalk.bold( test.name ) } suite` );
		logToConsole();
	} );

	harmonia.on( 'issue', ( issue: Issue ) => {
		let issueTypeString = issue.getTypeString();
		switch ( issue.type ) {
			case IssueType.Blocker:
				issueTypeString = chalk.bgRedBright.underline.bold( issueTypeString );
				break;
			case IssueType.Error:
				issueTypeString = chalk.bgRed.bold( issueTypeString );
				break;
			case IssueType.Warning:
				issueTypeString = chalk.bgYellow.bold( issueTypeString );
				break;
			case IssueType.Notice:
				issueTypeString = chalk.bgGray.bold( issueTypeString );
				break;
		}

		const documentation = issue.documentation ? `(${ issue.documentation })` : '';

		// Replace \n with \n\t\t to keep new lines aligned
		const message = issue.message.replace( /\n/g, '\n\t\t' );
		logToConsole( `    ${ issueTypeString } \t${ message } ${ documentation }` );

		// If it's a Blocker or Error, and the issue includes a stdout, print it out.
		const issueData = issue.getData();
		if ( issueData && [ IssueType.Blocker, IssueType.Error ].includes( issue.type ) ) {
			if ( issueData.all ) {
				logToConsole( issueData.all );
				logToConsole();
			} else if ( typeof issueData === 'string' ) {
				logToConsole( issueData );
				logToConsole();
			}
		}
	} );
}

function runHarmonia( harmonia ) {
	harmonia.run().then( async ( results: TestResult[] ) => await handleResults( harmonia, results ) );
}

async function handleResults( harmonia, results: TestResult[] ) {
	// Calculate the results
	const resultCounter = harmonia.countResults( false );
	const testSuiteResults = results.filter( result => result instanceof TestSuiteResult );

	// Send success event
	await trackEvent( 'validate_preflight_command_success', {
		command: 'vip validate preflight',
		...sanitizeArgsForTracking( harmoniaArgs ),
		skipped: resultCounter[ TestResultType.Skipped ],
		success: resultCounter[ TestResultType.Success ],
		partial_success: resultCounter[ TestResultType.PartialSuccess ],
		failed: resultCounter[ TestResultType.Failed ],
		aborted: resultCounter[ TestResultType.Aborted ],
	} );

	// If the output is JSON, reenable the logToConsole output and print-out the json format.
	if ( outputJson ) {
		suppressOutput = false;
		logToConsole( harmonia.resultsJSON() );
		process.exit( 0 );
	}

	// Print the results
	logToConsole( '\n' + chalk.bgGray( '        HARMONIA RESULTS        \n' ) );
	if ( resultCounter[ TestResultType.Skipped ] ) {
		logToConsole( ` ${ chalk.bold.bgGrey( ' SKIPPED ' ) } - ${ chalk.bold( resultCounter[ TestResultType.Skipped ] ) } tests` );
	}
	if ( resultCounter[ TestResultType.Success ] ) {
		logToConsole( ` ${ chalk.bold.bgGreen( ' PASSED ' ) } - ${ chalk.bold( resultCounter[ TestResultType.Success ] ) } tests` );
	}
	if ( resultCounter[ TestResultType.PartialSuccess ] ) {
		logToConsole( ` ${ chalk.bold.bgYellow( ' PARTIAL SUCCESS ' ) } - ${ chalk.bold( resultCounter[ TestResultType.PartialSuccess ] ) } tests` );
	}
	if ( resultCounter[ TestResultType.Failed ] ) {
		logToConsole( ` ${ chalk.bold.bgRed( ' FAILED ' ) } - ${ chalk.bold( resultCounter[ TestResultType.Failed ] ) } tests` );
	}
	if ( resultCounter[ TestResultType.Aborted ] ) {
		logToConsole( ` ${ chalk.bold.bgRedBright( ' ABORTED ' ) } - ${ chalk.bold( resultCounter[ TestResultType.Aborted ] ) } tests` );
	}

	logToConsole();
	logToConsole( ` > Total of ${ chalk.bold( results.length - testSuiteResults.length ) } tests have been executed.` );
	logToConsole();

	// If there is a Aborted test result
	if ( resultCounter[ TestResultType.Aborted ] ) {
		logToConsole( `${ chalk.bold.bgRedBright( '  NOT PASS  ' ) } There was a critical failure that makes the application ` +
			'incompatible with VIP Go. Please review the results and re-run the tests.' );
		process.exit( 1 );
	}

	// If there is only a partial success, but no failures
	if ( resultCounter[ TestResultType.PartialSuccess ] && ! resultCounter[ TestResultType.Failed ] ) {
		logToConsole( `${ chalk.bold.bgYellow( '  PASS  ' ) } The application has passed the required tests, but it does not follow all the recommendations.` );
		logToConsole( 'Please review the results.' );
		process.exit( 0 );
	}

	// If there is a failure
	if ( resultCounter[ TestResultType.Failed ] ) {
		logToConsole( `${ chalk.bold.bgRed( '  NOT PASS  ' ) } The application has failed some tests, and will very likely have problems in a production ` +
			'environment. Please review all the errors found in the results.' );
		process.exit( 1 );
	}

	logToConsole( `${ chalk.bold.bgGreen( '  PASS  ' ) } Congratulations. The application passes all the tests.` );
	process.exit( 0 );
}

async function validateArgs( opt ): Promise<{}> {
	const args = {};

	// Verbose
	if ( opt.verbose ) {
		Harmonia.setVerbosity( true );
	}

	// Set path
	if ( opt.path ) {
		Harmonia.setCwd( opt.path );
	}

	// If the JSON option is enabled, all the stdout should be suppressed to prevent polluting the output.
	if ( opt.json ) {
		suppressOutput = true;
		outputJson = true;
	}

	// Get build information from API and store it in the env object
	const buildConfig = await getBuildConfiguration( opt.app, opt.env );

	args.app_id = opt.app.id;
	args.env_id = opt.env.id;

	args.nodejsVersion = opt.nodeVersion ?? buildConfig.nodeJSVersion;
	args.buildType = buildConfig.buildType;
	args.npmToken = buildConfig.npmToken;
	args.nodeBuildDockerEnv = buildConfig.nodeBuildDockerEnv;

	args.wait = opt.wait ?? 3000;
	args.port = opt.port ?? Math.floor( Math.random() * 1000 ) + 3001; // Get a PORT from 3001 and 3999

	return args;
}

/**
 * Remove sensitive information from the tracked events and snake_case the keys.
 *
 * @param {object} args The arguments passed to the command.
 * @returns {object} Copy of the arguments without sensitive information.
 */
function sanitizeArgsForTracking( args: {} ): {} {
	const protectedKeys = [ 'npmToken', 'nodeBuildDockerEnv' ];
	const sanitizedArgs = { };

	Object.entries( args ).forEach( ( [ key, value ] ) => {
		if ( protectedKeys.includes( key ) ) {
			return;
		}
		// snake_case the key, as required by Tracks
		sanitizedArgs[ key.replace( /[A-Z]/g, letter => `_${ letter.toLowerCase() }` ) ] = value;
	} );

	return sanitizedArgs;
}

command( {
	appContext: true,
	appQuery,
	envContext: true,
	module: 'harmonia',
} )
	.option( 'verbose', 'Increase logging level to include app build and server boot up messages', false )
	.option( 'node-version', 'Select a specific target Node.JS version in semver format (MAJOR.MINOR.PATCH) or a MAJOR' )
	.option( 'wait', 'Configure the time to wait in ms for the app to boot up. Do not change unless you have issues', 3000 )
	.option( [ 'p', 'port' ], 'Configure the port to use for the app (defaults to a random port between 3001 and 3999)' )
	.option( 'json', 'Output the results as JSON', false )
	.option( [ 'P', 'path' ], 'Path to the app to be tested', process.cwd() )
	.examples( [
		{
			usage: 'vip @mysite.production validate preflight',
			description: 'Runs the preflight tests to validate if your application is ready to be deployed to VIP Go',
		},
		{
			usage: 'vip @mysite.production validate preflight --json > results.json',
			description: 'Runs the preflight tests, but output the results in JSON format, and redirect the output to a file',
		},
	] )
	.argv( process.argv, vipValidatePreflightCommand );
