var https = require("https");
var http = require("http");
var express = require("express");
var bodyParser = require("body-parser");
var databox = require("node-databox");
var Flickr = require("flickr-sdk");

var post_auth_callback = "/core-ui/ui/view/flickr-driver";

const DATABOX_ZMQ_ENDPOINT = process.env.DATABOX_ZMQ_ENDPOINT || "tcp://127.0.0.1:5555";
const DATABOX_TESTING = !(process.env.DATABOX_VERSION);
const PORT = process.env.port || '8080';

//flickr api keys
process.env.FLICKR_CONSUMER_KEY = '86d990038ab6911643c3e05d8d62ec2f';
process.env.FLICKR_CONSUMER_SECRET = '4c5ed23a22933a61';

var oauth = new Flickr.OAuth(
	process.env.FLICKR_CONSUMER_KEY,
	process.env.FLICKR_CONSUMER_SECRET
);

var db = {
	users: new Map(),
	oauth: new Map()
};

function getRequestToken(req, res) {
	oauth.request('https://127.0.0.1/core-ui/ui/view/flickr-driver/callback').then(function (_res) {
		var requestToken = _res.body.oauth_token;
		var requestTokenSecret = _res.body.oauth_token_secret;

		// store the request token and secret in the database
		db.oauth.set(requestToken, requestTokenSecret);

		// redirect the user to flickr and ask them to authorize your app.
        // perms default to "read", but you may specify "write" or "delete".
        const URL = oauth.authorizeUrl(requestToken, 'read');
        res.send(`<html><head><script>window.parent.location='${URL}';</script><head><body><body></html>`)
	}).catch(function (err) {
		res.statusCode = 400;
		res.end(err.message);
	});
}

function verifyRequestToken(req, res, query) {
	var requestToken = query.oauth_token;
	var oauthVerifier = query.oauth_verifier;

	// retrieve the request secret from the database
	var requestTokenSecret = db.oauth.get(requestToken);

	oauth.verify(requestToken, oauthVerifier, requestTokenSecret).then(function (_res) {
		var userNsid = _res.body.user_nsid;
		var oauthToken = _res.body.oauth_token;
		var oauthTokenSecret = _res.body.oauth_token_secret;

		// store the oauth token and secret in the database
		db.users.set(userNsid, {
			oauthToken: oauthToken,
			oauthTokenSecret: oauthTokenSecret
        });
        
        // we no longer need the request token and secret so we can delete them
	    db.oauth.delete(requestToken);
        
        process.env.FLICKR_OAUTH_TOKEN = oauthToken;
        process.env.FLICKR_OAUTH_TOKEN_SECRET = oauthTokenSecret;

		res.redirect("update");

	}).catch(function (err) {
		res.statusCode = 400;
		res.end(err.message);
	});
}

//create a keyvalue client for storing config
const kvc = databox.NewKeyValueClient(DATABOX_ZMQ_ENDPOINT, false);

//create store schema for saving key/value config data
const FlickrConfig = {
    ...databox.NewDataSourceMetadata(),
    Description: 'Flickr driver data',
    ContentType: 'application/json',
    Vendor: 'BBC',
    DataSourceType: 'flickr::photodata',
    DataSourceID: 'FlickrDataStore',
    StoreType: 'kv',
}

///now create our stores using our clients.
kvc.RegisterDatasource(FlickrConfig).then(() => {
    console.log("registered Flickr data driver");
}).catch((err) => { console.log("error registering Flickr data driver datasource", err) });
  
//set up webserver to serve driver endpoints
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.set('views', './views');
app.set('view engine', 'ejs');

app.get("/", function (req, res) {
    res.redirect("/ui/");
});

app.get("/ui", function (req, res) {

    kvc.Read(FlickrConfig.DataSourceID, "photosdata").then((result) => {
        res.render('index', { config: result.value });
    }).catch((err) => {
        console.log("get config error", err);
        res.send({ success: false, err });
    });
});

app.get("/ui/logout", function (req, res) {
    process.env.FLICKR_OAUTH_TOKEN = "";
    process.env.FLICKR_OAUTH_TOKEN_SECRET = "";
    res.redirect("..");
});

app.get("/ui/getauth", function (req, res) {
    return getRequestToken(req, res);
})

app.get("/ui/callback", function (req, res) {
    return verifyRequestToken(req, res, req.query);
})

app.get("/ui/checkauth", function(req, res) {
    console.log(req.query.post_auth_callback)
    post_auth_callback = req.query.post_auth_callback;
    try{
        var flickr = Flickr.OAuth.createPlugin(
            process.env.FLICKR_CONSUMER_KEY,
            process.env.FLICKR_CONSUMER_SECRET,
            process.env.FLICKR_OAUTH_TOKEN,
            process.env.FLICKR_OAUTH_TOKEN_SECRET
        );

        res.send(`<html><head><script>window.parent.location='${post_auth_callback}';</script><head><body><body></html>`)
    }
    catch(err) {
        console.log(err)
        res.redirect("getauth");
    }
})

app.get("/ui/update", function(req, res) {
    var flickr = new Flickr(Flickr.OAuth.createPlugin(
        process.env.FLICKR_CONSUMER_KEY,
        process.env.FLICKR_CONSUMER_SECRET,
        process.env.FLICKR_OAUTH_TOKEN,
        process.env.FLICKR_OAUTH_TOKEN_SECRET
    ));
    
    flickr.people.getPhotos({
        user_id: "me",
        authenticated: true,
        page: 1,
        per_page: 500,
        extras: "original_format"
    }).then(function(res) {
        //generating URLs to store
        var i;
        var data = [];
        for(i=0; i < res.body.photos.total; i++) {
            current = res.body.photos.photo[i];
            data[i] = ("https://farm"+current.farm+".staticflickr.com/"+current.server+"/"+current.id+"_"+current.originalsecret+"_o."+current.originalformat);
        }

        return new Promise((resolve, reject) => {
            kvc.Write(FlickrConfig.DataSourceID, "photosdata", { key: FlickrConfig.DataSourceID, value: data }).then(() => {
                console.log("successfully written:", data);
                resolve();
            }).catch((err) => {
                console.log("failed to write", err);
                reject(err);
            });
        });

    }).catch(function(err) {
        console.error('error retrieving photos', err);
    });
    setTimeout(function () {
        res.send(`<html><head><script>window.parent.location='${post_auth_callback}';</script><head><body><body></html>`);
      }, 1000);
});

app.get("/status", function (req, res) {
    res.send("active");
});

app.get("/ui/clear", function (req, res) {
    
    return new Promise((resolve, reject) => {
        kvc.Write(FlickrConfig.DataSourceID, "photosdata", { key: FlickrConfig.DataSourceID, value: "" }).then(() => {
            console.log("successfully cleared");
            resolve();
        }).catch((err) => {
            console.log("failed to clear", err);
            reject(err);
        });
    }).then(() => {
        res.redirect("..");
    });

})

//when testing, we run as http, (to prevent the need for self-signed certs etc);
if (DATABOX_TESTING) {
    console.log("[Creating TEST http server]", PORT);
    http.createServer(app).listen(PORT);
} else {
    console.log("[Creating https server]", PORT);
    const credentials = databox.getHttpsCredentials();
    https.createServer(credentials, app).listen(PORT);
}