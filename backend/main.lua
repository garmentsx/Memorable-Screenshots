local millennium = require("millennium")
local fs = require("fs")

local CACHE_DIR_NAME = "MemorableScreenshots"
local LOG_TAG = "[MemorableScreenshots] "

local function log(msg)
	local ok, logger = pcall(require, "logger")
	if ok and type(logger) == "table" and logger.info then
		pcall(logger.info, logger, LOG_TAG .. msg)
	else
		print(LOG_TAG .. msg)
	end
end

local json_ok, json_lib = pcall(require, "json")

local function json_escape(str)
	local escapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
	return (str:gsub('[%c"\\]', function(c)
		return escapes[c] or string.format("\\u%04x", c:byte())
	end))
end

local function fallback_encode(v)
	local kind = type(v)
	if kind == "table" then
		local out = {}
		if #v > 0 or next(v) == nil then
			for _, item in ipairs(v) do out[#out + 1] = fallback_encode(item) end
			return "[" .. table.concat(out, ",") .. "]"
		end
		for k, item in pairs(v) do
			out[#out + 1] = '"' .. json_escape(tostring(k)) .. '":' .. fallback_encode(item)
		end
		return "{" .. table.concat(out, ",") .. "}"
	elseif kind == "string" then
		return '"' .. json_escape(v) .. '"'
	elseif kind == "number" or kind == "boolean" then
		return tostring(v)
	end
	return "null"
end

local function encode(tbl)
	if json_ok and type(json_lib) == "table" and type(json_lib.encode) == "function" then
		local ok, res = pcall(json_lib.encode, tbl)
		if ok and type(res) == "string" then return res end
	end
	return fallback_encode(tbl)
end

local function failure(err)
	return encode({ ok = false, error = tostring(err), files = {} })
end

local function is_image(name)
	local lower = name:lower()
	return lower:match("%.jpe?g$") ~= nil or lower:match("%.png$") ~= nil
end

local function cache_root()
	return fs.join(millennium.steam_path(), "steamui", CACHE_DIR_NAME)
end

local function find_screenshots(appid)
	local found = {}
	local accounts = fs.list(fs.join(millennium.steam_path(), "userdata"))
	if not accounts then return found end

	for _, account in ipairs(accounts) do
		if account.is_directory and account.name:match("^%d+$") then
			local dir = fs.join(account.path, "760", "remote", tostring(appid), "screenshots")
			for _, entry in ipairs(fs.is_directory(dir) and fs.list(dir) or {}) do
				if entry.is_file and is_image(entry.name) then
					found[#found + 1] = { name = entry.name, path = entry.path }
				end
			end
		end
	end

	table.sort(found, function(a, b) return a.name > b.name end)
	return found
end

local function cache_screenshot(shot, dest_dir)
	local dest = fs.join(dest_dir, shot.name)
	local cached_size = fs.is_file(dest) and fs.file_size(dest)
	if not (cached_size and cached_size == fs.file_size(shot.path)) then
		local copied, err = fs.copy(shot.path, dest, false)
		if not copied then
			log("copy failed for " .. shot.name .. ": " .. tostring(err))
		end
	end
	return fs.is_file(dest)
end

local function get_screenshots_impl(arg)
	local appid = tonumber(type(arg) == "table" and (arg.appid or arg[1]) or arg)
	if not appid then return failure("invalid appid") end

	local ok, result = pcall(function()
		local shots = find_screenshots(appid)
		if #shots == 0 then return {} end

		local dest_dir = fs.join(cache_root(), tostring(appid))
		fs.create_directories(dest_dir)

		local files = {}
		for i = 1, #shots do
			if cache_screenshot(shots[i], dest_dir) then
				files[#files + 1] = shots[i].name
			end
		end
		return files
	end)

	if not ok then
		log("get_screenshots error: " .. tostring(result))
		return failure(result)
	end
	return encode({ ok = true, files = result })
end

function get_screenshots(arg)
	local ok, res = pcall(get_screenshots_impl, arg)
	return ok and res or failure(res)
end

return {
	on_frontend_loaded = function() log("frontend loaded") end,
	on_load = function()
		log("loaded, steam path: " .. tostring(millennium.steam_path()))
		millennium.ready()
	end,
	on_unload = function() log("unloaded") end,
	get_screenshots = get_screenshots,
}
