const dateTimeFormat = new Intl.DateTimeFormat('default', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    timeZone: 'utc',
    timeZoneName: 'short'
})

export function humanReadableSize(bytes) {
    if (bytes === 0) {
        return '0 Bytes'
    }
    const decimals = 2
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)).toString()} ${sizes[i]}`
}

export function humanReadableDate(dateString) {
    const date = Date.parse(dateString)
    return dateTimeFormat.format(date)
}

export function toJson(object) {
    return JSON.stringify(object);
}

export function fromJson(object) {
    return JSON.parse(object);
}

